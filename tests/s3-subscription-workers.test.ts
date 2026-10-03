/**
 * S3 of subscription-aware orchestration: a Personal Nectovia lead hands a task to the person's
 * own coding tool, when they turned that on.
 *
 * The first blocks are pure: the reserve rule, the preference record and the paid record's gate
 * call. The start-route blocks mount the real loop routes over a scripted harness, the way the
 * Nectovia board tests do, so every branch of the host's choice runs without a provider. The last
 * block runs the real app over the faux account service with a scripted managed gateway and a
 * scripted engine port: a signed-in Individual person, their Personal project, a Nectovia lead
 * that hands one task to Codex. The account service publishes a real route policy and the person
 * accepts a privacy profile, so the Personal tier resolves the way it does for a customer; the
 * route's provider is never called. Nothing here reaches a provider or a real engine.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '../server/paths.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { NECTOVIA_LOOP_TEAM_REFUSED, loopRunId, mountNativeLoopRoutes } from '../server/native-loop-routes.js';
import { SubscriptionWorkers, paidWorkerAdmission } from '../server/subscription-workers.js';
import {
  ExternalWorkerGate,
  externalWorkerAdapter,
  type ExternalWorkerAdmission,
  type ExternalWorkerPort,
} from '../server/harness/external-worker.js';
import { EXTERNAL_WORKER_INSTRUCTIONS } from '../server/harness/capabilities/team-loop.js';
import {
  RESERVE_READING_MAX_AGE_MS,
  SUBSCRIPTION_WORKERS_CONSENT_REVISION,
  reserveRefusal,
  type SubscriptionWorkersWrite,
} from '../shared/subscription-workers.js';
import { MANAGED_LUNA, NECTOVIA_ROUTE } from '../shared/model-api.js';
import { TEAM_LIMITS, TEAM_WORKER_CAPABILITY, type TeamConfig } from '../shared/team-delegation.js';
import type { ModelRequest } from '../shared/harness.js';
import type { UsageWindow } from '../shared/types.js';
import { NO_TRAINING_RESTRICTIONS, ROUTING_CONSENT_VERSION, type ModelBinding, type ProviderConnection } from '../shared/routing-policy.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const window = (usedPercent: number, id = 'primary'): UsageWindow => ({ id, label: '5 hours', usedPercent, resetsAt: null, durationMins: 300 });
const reading = (used: number[], at = NOW) => ({ windows: used.map((value, index) => window(value, index ? 'secondary' : 'primary')), at: new Date(at).toISOString() });

describe('the reserve rule', () => {
  const keep = { kind: 'provider-window', keepPercent: 30 } as const;

  test('no reserve never refuses, whatever was reported', () => {
    expect(reserveRefusal({ kind: 'none' }, null, NOW, 'Codex')).toBeNull();
  });

  test('enough left passes; at or under the reserve refuses and names both numbers', () => {
    expect(reserveRefusal(keep, reading([50]), NOW, 'Codex')).toBeNull();
    const refused = reserveRefusal(keep, reading([75]), NOW, 'Codex');
    expect(refused).toBe('You keep 30% of Codex’s usage limit for your own work, and 25% is left, so it wasn’t given this task.');
    expect(reserveRefusal(keep, reading([70]), NOW, 'Codex')).toMatch(/30% is left/);
  });

  test('the tightest window decides', () => {
    expect(reserveRefusal(keep, reading([10, 80]), NOW, 'Codex')).toMatch(/20% is left/);
  });

  test('a reading that is missing, empty or stale reads as not met, never as plenty left (N29)', () => {
    for (const value of [null, undefined, { windows: [], at: new Date(NOW).toISOString() }, reading([5], NOW - RESERVE_READING_MAX_AGE_MS - 1)])
      expect(reserveRefusal(keep, value, NOW, 'Claude Code')).toBe(
        'You keep 30% of Claude Code’s usage limit for your own work, and Claude Code hasn’t reported how much is left, so it wasn’t given this task.',
      );
  });

  test('its sentences keep the copy rules', () => {
    for (const text of [reserveRefusal(keep, reading([75]), NOW, 'Codex')!, reserveRefusal(keep, null, NOW, 'Codex')!]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/Nothing was/);
    }
  });
});

// --- the preference ----------------------------------------------------------------------------

const ON: SubscriptionWorkersWrite = {
  enabled: true,
  engines: ['codex', 'claude-code'],
  reserve: { kind: 'none' },
  whenUnavailable: 'single-agent',
  consentRevision: SUBSCRIPTION_WORKERS_CONSENT_REVISION,
};

describe('the subscription worker preference', () => {
  let root: string;
  let store: Store;
  let flags: { available: boolean; person: string | null; owner: string | null };
  let workers: SubscriptionWorkers;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-s3-preference-'));
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    flags = { available: true, person: 'person_a', owner: null };
    workers = new SubscriptionWorkers({
      store,
      available: () => flags.available,
      personId: () => flags.person,
      projectOwner: () => flags.owner,
      now: () => NOW,
    });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('off by default: nothing stored, nothing chosen', () => {
    expect(store.settings.subscriptionWorkers).toBeNull();
    expect(workers.preference()).toBeNull();
    expect(workers.choice('p1')).toEqual({ kind: 'off' });
  });

  test('a saved preference names its person and is that person’s only', async () => {
    const saved = await workers.save(ON);
    expect(saved).toEqual({
      version: 1,
      personId: 'person_a',
      scope: { kind: 'personal' },
      enabled: true,
      engines: ['codex', 'claude-code'],
      reserve: { kind: 'none' },
      whenUnavailable: 'single-agent',
      consentRevision: SUBSCRIPTION_WORKERS_CONSENT_REVISION,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(workers.choice('p1')).toMatchObject({ kind: 'candidates', engines: ['codex', 'claude-code'] });
    // Someone else signed in on this computer.
    flags.person = 'person_b';
    expect(workers.preference()).toBeNull();
    expect(workers.choice('p1')).toEqual({ kind: 'off' });
    flags.person = null;
    expect(workers.choice('p1')).toEqual({ kind: 'off' });
  });

  test('a project a business owns never uses it (D13)', async () => {
    await workers.save(ON);
    flags.owner = 'org_juniper';
    expect(workers.choice('p1')).toEqual({ kind: 'off' });
  });

  test('a build without the launch gate or the engine port offers nothing and saves nothing', async () => {
    await workers.save(ON);
    flags.available = false;
    expect(workers.choice('p1')).toEqual({ kind: 'off' });
    await expect(workers.save(ON)).rejects.toMatchObject({ status: 409, details: { code: 'subscription_workers_unavailable' } });
  });

  test('a consent saved under another revision is asked again (N20)', async () => {
    await workers.save(ON);
    await store.saveSettings({ ...store.settings, subscriptionWorkers: { ...store.settings.subscriptionWorkers!, consentRevision: '2026-01-01.1' } });
    const choice = workers.choice('p1');
    expect(choice).toMatchObject({ kind: 'unavailable' });
    expect(choice.kind === 'unavailable' && choice.reason).toMatch(/Confirm it again in Settings/);
    await expect(workers.save({ ...ON, consentRevision: '2026-01-01.1' })).rejects.toMatchObject({
      status: 409,
      details: { code: 'subscription_consent_changed', consentRevision: SUBSCRIPTION_WORKERS_CONSENT_REVISION },
    });
  });

  test('turning it on needs a person, a tool and a whole answer; turning it off always works', async () => {
    flags.person = null;
    await expect(workers.save(ON)).rejects.toMatchObject({ status: 401 });
    flags.person = 'person_a';
    await expect(workers.save({ ...ON, engines: [] })).rejects.toMatchObject({ status: 400 });
    await expect(workers.save({ ...ON, engines: ['codex', 'codex'] })).rejects.toMatchObject({ status: 400 });
    const { whenUnavailable: _omitted, ...partial } = ON;
    await expect(workers.save(partial)).rejects.toMatchObject({ status: 400 });
    await expect(workers.save({ ...ON, reserve: { kind: 'provider-window', keepPercent: 95 } })).rejects.toMatchObject({ status: 400 });
    await expect(workers.save({ ...ON, engines: ['cursor'] })).rejects.toMatchObject({ status: 400 });
    const off = await workers.save({ ...ON, enabled: false, engines: [], consentRevision: 'old' });
    expect(off.enabled).toBe(false);
    expect(workers.choice('p1')).toEqual({ kind: 'off' });
  });

  test('the Settings view carries the consent a person agrees to', async () => {
    const view = workers.view();
    expect(view).toMatchObject({ available: true, signedIn: true, preference: null, consent: { revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION } });
    expect(view.consent.text).toMatch(/signed in with your account, never through a chat app/);
    expect(view.consent.text).not.toMatch(/[—–]/);
  });
});

describe('the paid record a worker under a Nectovia lead carries', () => {
  test('only a Nectovia lead asks the gate, with route kind external-engine under the lead’s job', async () => {
    const check = vi.fn(async () => ({}) as never);
    const admit = paidWorkerAdmission({ check });
    await admit({ route: 'google-vertex', projectId: 'p1', rootJobId: 'Rjob' });
    expect(check).not.toHaveBeenCalled();
    await admit({ route: NECTOVIA_ROUTE, projectId: 'p1', rootJobId: 'Rjob' });
    expect(check).toHaveBeenCalledWith({ phase: 'admit', surface: 'loop', projectId: 'p1', rootJobId: 'Rjob', routeKind: 'external-engine' });
  });
});

describe('the external worker adapter holds the reserve before its turn', () => {
  test('a reserve not met at admission fails the child in validatePrepared; nothing is sent', async () => {
    const sends: unknown[] = [];
    const port: ExternalWorkerPort = {
      async admit(route, input) {
        return { route, model: input.model ?? 'gpt-codex-test', accountRoute: input.accountRoute ?? 'codex:chatgpt', version: '0.150.0', usage: reading([90]) };
      },
      async send() {
        sends.push(1);
        return { text: 'unreachable', model: null, version: '0.150.0' };
      },
    };
    const adapter = await externalWorkerAdapter(port, {
      route: 'codex',
      projectId: 'p1',
      runId: 'child-1',
      model: 'gpt-codex-test',
      accountRoute: 'codex:chatgpt',
      instructions: EXTERNAL_WORKER_INSTRUCTIONS,
      documents: async () => [],
      stop: new AbortController().signal,
      gate: new ExternalWorkerGate(),
      reserve: (admission: ExternalWorkerAdmission) =>
        reserveRefusal({ kind: 'provider-window', keepPercent: 20 }, admission.usage, Date.parse(admission.usage!.at), 'Codex'),
    });
    const request: ModelRequest = { runId: 'child-1', capabilityId: TEAM_WORKER_CAPABILITY, messages: [{ role: 'user', text: 'Count the napkins.' }], tools: [], transcript: null };
    await expect(adapter.validatePrepared!(request)).rejects.toMatchObject({ code: 'subscription_reserve' });
    expect(sends).toEqual([]);
  });
});

// --- the start route ---------------------------------------------------------------------------

const MODEL = MANAGED_LUNA.model;
const ACCOUNT_ROUTE = `${NECTOVIA_ROUTE}:individual_test`;

describe('a Nectovia start takes its worker from the person’s preference', () => {
  let root: string;
  let store: Store;
  let server: Server | undefined;
  let base: string;
  let projectId: string;
  let taskId: string;
  let flags: { available: boolean; person: string | null; owner: string | null };
  let workers: SubscriptionWorkers;
  let routes: ReturnType<typeof mountNativeLoopRoutes>;
  let admitManagedCalls: string[];
  let externalCalls: { route: string; model: string | null; accountRoute: string | null }[];
  /** Per route: what its own admission answers, or the error it refuses with. */
  let engines: Record<string, Error | { usage?: ReturnType<typeof reading> | null }>;
  let runs: Map<string, any>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-s3-start-'));
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    const project = await store.createProject('Linen orders');
    projectId = project.id;
    await fs.writeFile(path.join(project.folder, 'order.md'), 'Order 1182: 100 napkins.\n');
    taskId = await store.locked(async () => {
      const task = store.createTask(store.state(projectId), { name: 'Check the linen order' });
      const state = store.state(projectId);
      state.cloudSharing = {
        version: 1,
        routes: [NECTOVIA_ROUTE, 'codex', 'claude-code'] as any,
        documents: ['order.md'],
        shareConversationHistory: false,
        shareReviewPackets: false,
      };
      await store.persist(state);
      return task.id;
    });
    await store.saveSettings({
      ...store.settings,
      services: {
        ...(store.settings.services ?? {}),
        codex: true,
        codexModel: 'gpt-codex-test',
        'claude-code': true,
        'claude-codeModel': 'claude-test',
        'claude-codeAccountRoute': 'claude-code:claude.ai',
      },
    });
    flags = { available: true, person: 'person_a', owner: null };
    workers = new SubscriptionWorkers({ store, available: () => flags.available, personId: () => flags.person, projectOwner: () => flags.owner });
    admitManagedCalls = [];
    externalCalls = [];
    engines = { codex: { usage: null }, 'claude-code': { usage: null } };
    runs = new Map();
    const harness: any = {
      get: async (_projectId: string, runId: string) => {
        const run = runs.get(runId);
        if (!run) throw new ApiError(404, 'not found');
        return run;
      },
      list: async () => [...runs.values()],
      bridge: {
        start: async (pid: string, tid: string, capabilityId: string, _goal: string, _principal: unknown, _u: unknown, opts: any) => {
          const session = { id: `sess-${opts.runId}`, projectId: pid };
          runs.set(opts.runId, { id: opts.runId, capabilityId, sessionId: session.id, taskId: tid, projectId: pid, input: opts.input, state: 'running' });
          return session;
        },
      },
      loop: {
        admit: async (route: string) => {
          throw new ApiError(409, `unexpected loop admission for ${route}`);
        },
        admitExternalWorker: async (route: string, input: { model: string | null; accountRoute: string | null }) => {
          externalCalls.push({ route, model: input.model, accountRoute: input.accountRoute });
          const script = engines[route];
          if (!script) throw new Error(`No script for ${route}.`);
          if (script instanceof Error) throw script;
          return { model: input.model ?? 'model', accountRoute: input.accountRoute ?? `${route}:account`, accountDigest: null, usage: script.usage ?? null };
        },
        children: async () => [],
        teamView: async () => null,
        changeSets: { views: async () => [], diff: async () => ({}) },
      },
      scrub: (value: unknown) => value,
      redact: (value: string) => value,
    };
    const app = express();
    app.use(express.json());
    routes = mountNativeLoopRoutes(
      app,
      store as any,
      harness,
      {} as any,
      null,
      () => true,
      {
        resolveManaged: () => ({ model: MODEL, accountRoute: ACCOUNT_ROUTE }),
        readOnly: () => ({ admitted: true, model: MODEL, reason: null }),
        admitManaged: async (_pid: string, runId: string, input: { model: string; accountRoute: string }) => {
          admitManagedCalls.push(runId);
          return input;
        },
      },
      null,
      null,
      workers,
    );
    app.use(((error: any, _req: any, res: any, _next: any) => {
      res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: error?.message ?? 'failed', ...(error?.details ?? {}) });
    }) as any);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      server = undefined;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function start(extra: Record<string, unknown> = {}, commandId = `s3-${Math.random().toString(36).slice(2)}`) {
    const response = await fetch(`${base}/api/projects/${projectId}/loop/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        commandId,
        taskId,
        goal: 'Check the linen order.',
        route: NECTOVIA_ROUTE,
        consent: true,
        // What the person confirmed: the tools ON names, under the current consent text.
        workerConsent: { revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION, engines: ['codex', 'claude-code'] },
        sources: ['order.md'],
        ...extra,
      }),
    });
    const json = (await response.json()) as any;
    return { status: response.status, json, input: runs.get(loopRunId(projectId, commandId))?.input as any };
  }

  test('preference off: single-agent as before, and no tool is asked', async () => {
    const started = await start();
    expect(started.status).toBe(200);
    expect(started.input.team).toBeUndefined();
    expect(started.input.subscriptionWorker).toBeUndefined();
    expect(externalCalls).toEqual([]);
    expect(admitManagedCalls).toHaveLength(1);
  });

  test('preference on: the first tool in the person’s order takes one worker role on their plan', async () => {
    await workers.save(ON);
    const started = await start();
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const team = started.input.team as TeamConfig;
    expect(team.origin).toBe('subscription-preference');
    expect(team.scope).toEqual(['order.md']);
    expect(team.worker).toMatchObject({ route: 'codex', model: 'gpt-codex-test', accountRoute: 'codex:chatgpt', execution: 'external-proposal' });
    expect(team.worker.budget).toEqual({ turns: 1, tokens: TEAM_LIMITS.worker.tokens, wallMs: TEAM_LIMITS.worker.wallMs });
    expect(team.advisor).toBeNull();
    expect(team.limits.concurrentWorkers).toBe(1);
    expect(started.input.subscriptionWorker).toEqual({
      state: 'attached',
      route: 'codex',
      reason: null,
      reserve: { kind: 'none' },
      consentRevision: SUBSCRIPTION_WORKERS_CONSENT_REVISION,
    });
    expect(externalCalls.map((item) => item.route)).toEqual(['codex']);
    expect(admitManagedCalls).toHaveLength(1);
  });

  test('without consent the start says the task may go to the person’s tools, and nothing is admitted', async () => {
    await workers.save(ON);
    const refused = await start({ consent: false });
    expect(refused.status).toBe(409);
    expect(refused.json.consentRequired).toBe(true);
    expect(refused.json.error).toBe(
      'Your goal and the files the loop reads will be sent to Nectovia, and a task it hands off goes to Codex or Claude Code with the files it needs, signed in with your own account. Confirm before sending.',
    );
    expect(refused.json.workerConsent).toEqual({ revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION, engines: ['codex', 'claude-code'] });
    expect(externalCalls).toEqual([]);
    expect(admitManagedCalls).toEqual([]);
  });

  test('a bare consent never reaches the person’s tools: the start asks again, naming them', async () => {
    await workers.save(ON);
    const confirm = { revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION, engines: ['codex', 'claude-code'] };
    for (const workerConsent of [
      undefined,
      { ...confirm, engines: ['codex'] },
      { ...confirm, engines: ['codex', 'opencode'] },
      { ...confirm, revision: '2026-01-01.1' },
    ]) {
      const refused = await start({ workerConsent });
      expect(refused.status, JSON.stringify(workerConsent)).toBe(409);
      expect(refused.json).toMatchObject({ consentRequired: true, workerConsent: confirm });
    }
    expect(externalCalls).toEqual([]);
    expect(admitManagedCalls).toEqual([]);
    expect(runs.size).toBe(0);
    // The person's order doesn't matter, only the tools.
    const started = await start({ workerConsent: { ...confirm, engines: ['claude-code', 'codex'] } });
    expect(started.status).toBe(200);
    expect(started.input.team.worker.route).toBe('codex');
  });

  test('a host start keeps the lead single-agent: Board work and the Ready queue never use a subscription (D12)', async () => {
    await workers.save(ON);
    const started = await store.locked(() =>
      routes.startHostLocked(projectId, {
        protocolVersion: 1,
        commandId: 's3-host-start',
        taskId,
        goal: 'Check the linen order.',
        route: NECTOVIA_ROUTE,
        consent: true,
        workerConsent: { revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION, engines: ['codex', 'claude-code'] },
        sources: ['order.md'],
      }),
    );
    const input = runs.get(started.runId).input;
    expect(input.team).toBeUndefined();
    expect(input.subscriptionWorker).toBeUndefined();
    expect(externalCalls).toEqual([]);
    expect(admitManagedCalls).toHaveLength(1);
  });

  test('a tool that refuses gives way to the next one in the person’s order', async () => {
    await workers.save(ON);
    engines.codex = new Error('Sign in to Codex again, in Codex.');
    const started = await start();
    expect(started.status).toBe(200);
    expect(started.input.team.worker.route).toBe('claude-code');
    expect(externalCalls.map((item) => item.route)).toEqual(['codex', 'claude-code']);
  });

  test('no tool ready, single-agent chosen: the lead runs alone and the run keeps why (A06, N24)', async () => {
    await workers.save(ON);
    engines.codex = new Error('Sign in to Codex again, in Codex.');
    engines['claude-code'] = new Error('Claude Code is not installed.');
    const started = await start();
    expect(started.status).toBe(200);
    expect(started.input.team).toBeUndefined();
    expect(started.input.subscriptionWorker).toMatchObject({ state: 'unavailable', route: null });
    expect(started.input.subscriptionWorker.reason).toBe('Sign in to Codex again, in Codex. Claude Code is not installed.');
    expect(admitManagedCalls).toHaveLength(1);
  });

  test('no tool ready, hold chosen: the start is refused before any paid admission (N36)', async () => {
    await workers.save({ ...ON, whenUnavailable: 'pause' });
    engines.codex = new Error('Sign in to Codex again, in Codex.');
    engines['claude-code'] = new Error('Claude Code is not installed.');
    const held = await start();
    expect(held.status).toBe(409);
    expect(held.json.code).toBe('subscription_worker_unavailable');
    expect(held.json.error).toBe(
      'Sign in to Codex again, in Codex. Claude Code is not installed. You chose to hold work until one of your coding tools can take it, so this didn’t start.',
    );
    expect(admitManagedCalls).toEqual([]);
    expect(runs.size).toBe(0);
  });

  test('a reserve not met skips that tool; a tool that reports nothing can’t meet one (N28, N29)', async () => {
    await workers.save({ ...ON, reserve: { kind: 'provider-window', keepPercent: 30 } });
    engines.codex = { usage: reading([75], Date.now()) };
    engines['claude-code'] = { usage: null };
    const started = await start();
    expect(started.status).toBe(200);
    expect(started.input.team).toBeUndefined();
    expect(started.input.subscriptionWorker.reason).toBe(
      'You keep 30% of Codex’s usage limit for your own work, and 25% is left, so it wasn’t given this task. You keep 30% of Claude Code’s usage limit for your own work, and Claude Code hasn’t reported how much is left, so it wasn’t given this task.',
    );
    engines.codex = { usage: reading([40], Date.now()) };
    const second = await start();
    expect(second.input.team.worker.route).toBe('codex');
    expect(second.input.subscriptionWorker.reserve).toEqual({ kind: 'provider-window', keepPercent: 30 });
  });

  test('a business project keeps the business’s single-agent path (N22)', async () => {
    await workers.save(ON);
    flags.owner = 'org_juniper';
    const started = await start();
    expect(started.status).toBe(200);
    expect(started.input.team).toBeUndefined();
    expect(started.input.subscriptionWorker).toBeUndefined();
    expect(externalCalls).toEqual([]);
  });

  test('a stale consent with hold chosen asks again before anything starts (N20)', async () => {
    await workers.save({ ...ON, whenUnavailable: 'pause' });
    await store.saveSettings({ ...store.settings, subscriptionWorkers: { ...store.settings.subscriptionWorkers!, consentRevision: '2026-01-01.1' } });
    const held = await start();
    expect(held.status).toBe(409);
    expect(held.json.error).toMatch(/^What handing tasks to your coding tools sends has changed\. Confirm it again in Settings/);
    expect(externalCalls).toEqual([]);
  });

  test('a team or delegate the person names is still refused on Nectovia', async () => {
    await workers.save(ON);
    for (const extra of [{ team: { worker: { route: 'codex' } } }, { delegate: { route: 'native-fixture' } }]) {
      const refused = await start(extra);
      expect(refused.status).toBe(409);
      expect(refused.json.error).toBe(NECTOVIA_LOOP_TEAM_REFUSED);
    }
    expect(externalCalls).toEqual([]);
  });

  test('a Retry brings the same tool back only while the person’s settings still allow it', async () => {
    await workers.save(ON);
    const first = await start({}, 's3-retry-first');
    const team = first.input.team as TeamConfig;
    const request = {
      protocolVersion: 1 as const,
      commandId: 's3-retry-second',
      taskId,
      goal: 'Check the linen order.',
      route: NECTOVIA_ROUTE,
      consent: true,
      sources: ['order.md'],
    };
    const again = await store.locked(() =>
      routes.startHostLocked(projectId, request, { team, retryOf: { runId: loopRunId(projectId, 's3-retry-first'), attempt: 2 } }),
    );
    const retried = runs.get(again.runId).input;
    expect(retried.team.worker.route).toBe('codex');
    expect(retried.subscriptionWorker).toMatchObject({ state: 'attached', route: 'codex' });
    // The person took Codex off their list since.
    await workers.save({ ...ON, engines: ['claude-code'] });
    await expect(
      store.locked(() =>
        routes.startHostLocked(projectId, { ...request, commandId: 's3-retry-third' }, { team, retryOf: { runId: loopRunId(projectId, 's3-retry-first'), attempt: 3 } }),
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: 'subscription_worker_changed' } });
    // A recorded team that the host didn't choose never joins a Nectovia lead.
    const { origin: _origin, ...named } = team;
    await expect(
      store.locked(() => routes.startHostLocked(projectId, { ...request, commandId: 's3-retry-fourth' }, { team: named as TeamConfig })),
    ).rejects.toMatchObject({ status: 409, message: NECTOVIA_LOOP_TEAM_REFUSED });
  });
});

// --- through the real app, over the faux account service ---------------------------------------

describe('a Personal Nectovia lead hands one task to the person’s own Codex (A05)', () => {
  type Item = Record<string, unknown>;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const DELIVERY = 'Delivered 94 napkins and 40 tablecloths. Six napkins short.\n';
  let root: string;
  let cloud: FauxCloud;
  let engines: EngineService;
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server | undefined;
  let base: string;
  let gatewayBodies: Item[];
  let admissions: Item[];
  let sends: { route: string; prompt: string; documents: { path: string }[] }[];
  /** The account service's one model connection. The scripted gateway answers before it is reached. */
  const connection: ProviderConnection = {
    id: 'fixture-azure',
    revision: 1,
    label: 'Synthetic Azure',
    provider: 'azure-openai',
    secretRef: 'AZURE_OPENAI_API_KEY',
    payer: 'company',
    account: 'fixture',
    enabled: true,
    resource: 'fixture-resource',
    apiVersion: 'v1',
    deployments: ['primary'],
  };

  /**
   * The attempt record the account service's gateway returns with a versioned policy: one settled
   * attempt on the published route, matched to this request's account, attempt and revisions,
   * all of which the request's own headers carry.
   */
  function receipt(headers: Headers) {
    const attempt = headers.get('x-nectovia-attempt') ?? '';
    const revision = (name: string) => Number(headers.get(name) ?? 0);
    const at = new Date().toISOString();
    const scopeKey =
      headers.get('x-nectovia-scope-kind') === 'individual'
        ? `individual:${headers.get('x-nectovia-account')}`
        : `organization:${headers.get('x-nectovia-organization')}`;
    return {
      attempts: [
        {
          attemptId: attempt,
          state: 'settled',
          routing: {
            scopeKey,
            policyRevision: revision('x-nectovia-policy-revision'),
            globalRevision: revision('x-nectovia-global-revision'),
            scopeRevision: revision('x-nectovia-scope-revision'),
            preferenceRevision: revision('x-nectovia-preference-revision'),
            requestGroup: attempt,
            ordinal: 1,
            fallbackReason: null,
            routeId: 'primary',
            routeRevision: revision('x-nectovia-route-revision'),
            provider: 'azure-openai',
            model: 'fixture-non-luna',
            modelVersion: 'fixture-non-luna',
            deployment: 'primary',
            upstreamEndpoint: null,
            connectionId: connection.id,
            connectionRevision: 1,
            protocol: 'chat-completions',
            priceVersion: 'fixture-v1',
            priceObservedAt: at,
            priceValidUntil: new Date(Date.now() + 3_600_000).toISOString(),
          },
          heldMicroUsd: 13,
          providerCostMicroUsd: 13,
          allowanceDebitMicroUsd: 13,
        },
      ],
      allowanceDebitMicroUsd: 13,
      heldMicroUsd: 13,
    };
  }

  /** The managed gateway, scripted: a plan, then one hand-off to a worker, then a final answer. */
  async function gateway(request: Request): Promise<Response> {
    const body = (await request.clone().json()) as Item;
    gatewayBodies.push(body);
    const n = gatewayBodies.length;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const answered = JSON.stringify(body.input ?? []).includes('function_call_output');
    const output =
      tools.length && !answered
        ? {
            type: 'function_call',
            id: `fc_${n}`,
            call_id: `call_assign_${n}`,
            name: 'assign_workers',
            status: 'completed',
            arguments: JSON.stringify({ tasks: [{ task: 'What is short in the delivery?', files: ['delivery.md'] }] }),
          }
        : {
            type: 'message',
            id: `msg_${n}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', annotations: [], text: tools.length ? 'Six napkins are short, as the worker found.' : '1. Ask a worker.\n2. Report.' }],
          };
    return sseResponse(
      responsesEvents({
        id: `resp_${n}`,
        object: 'response',
        created_at: 1_790_000_000,
        model: String(body.model),
        status: 'completed',
        output: [output],
        usage: { input_tokens: 90, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 98 },
        incomplete_details: null,
        error: null,
        ...(request.headers.get('x-nectovia-protocol') ? { nectovia: receipt(request.headers) } : {}),
      }),
      { 'x-nectovia-attempt': request.headers.get('x-nectovia-attempt') ?? '' },
    );
  }

  /** The person's own Codex, scripted: admitted on ChatGPT with no usage reading, one answer per turn. */
  const port: ExternalWorkerPort = {
    async admit(route, input) {
      return {
        route,
        model: input.model ?? 'gpt-codex-test',
        accountRoute: input.accountRoute ?? 'codex:chatgpt',
        version: '0.150.0',
        accountDigest: 'openai:chatgpt:digest-1',
        usage: null,
      };
    },
    async send(route, _admission, turn) {
      sends.push({ route, prompt: turn.prompt, documents: turn.documents.map((item) => ({ path: item.path })) });
      return { text: 'Six napkins are short.', model: 'gpt-codex-reported', version: '0.150.0', threadId: 'thr_1' };
    },
  };

  const api = async <T = any>(route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
  };
  const ok = async <T = any>(route: string, method = 'GET', body?: unknown) => {
    const answer = await api<T>(route, method, body);
    expect(answer.status, `${method} ${route}: ${JSON.stringify(answer.data)}`).toBe(200);
    return answer.data;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-s3-e2e-'));
    gatewayBodies = [];
    admissions = [];
    sends = [];
    cloud = await createFauxCloud({
      file: null,
      passwordIterations: 1_000,
      managed: {
        bindings: { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'synthetic-provider-key' },
        transport: async () => {
          throw new Error('The scripted gateway answers every model call in this file.');
        },
      },
    });
    await seedDemo(cloud);
    const backend: AccountBackend = {
      client: new ControlPlaneClient('http://faux.local', async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith('/managed/v1/')) return gateway(request);
        // Business work is admitted at /agent-admissions; Personal work at its routing scope.
        if (request.method === 'POST' && (pathname.endsWith('/agent-admissions') || /^\/account\/routing\/(organization|individual)\/[^/]+\/admit$/.test(pathname)))
          admissions.push((await request.clone().json()) as Item);
        return cloud.handle(request);
      }),
      view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
      close: async () => {},
    };
    engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
    app = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      engineService: engines,
      reviewerAdapter: null,
      secretBox: testOnlySecretBox(),
      modelApiTransport: (async () => {
        throw new Error('No provider is called in this file.');
      }) as typeof globalThis.fetch,
      accounts: { backend, env: {} },
      externalWorkers: port,
      subscriptionWorkers: true,
    });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    if (server) {
      await app.locals.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      server = undefined;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A call to the account service as one of its people, which must succeed. */
  async function cloudApi(method: string, url: string, bearer: string, value?: unknown) {
    const response = await cloud.handle(
      new Request(`http://faux.local${url}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
    );
    const body = await response.json();
    expect(response.ok, `${method} ${url}: ${JSON.stringify(body)}`).toBe(true);
    return body as Item;
  }

  /**
   * The account service's side of Personal Nectovia work: one qualified route the global policy
   * publishes for every tier (the operations routing client test's synthetic binding), the
   * person's Individual plan, a managed usage agreement on their Individual account, and their
   * accepted Balanced privacy profile, the default a new account gets. Without the policy and the profile a Personal tier has no model.
   */
  async function individualPerson() {
    const token = async (email: string) =>
      ((await cloudApi('POST', '/auth/sign-in', '', { email, password: FAUX_DEMO_PASSWORD, remember: false })) as { accessToken: string }).accessToken;
    const routing = await token(DEMO_ACCOUNTS.staffRouting.email);
    const billing = await token(DEMO_ACCOUNTS.staffBilling.email);
    const now = Date.now();
    const at = new Date(now).toISOString();
    const until = new Date(now + 3_600_000).toISOString();
    const binding: ModelBinding = {
      connectionId: connection.id,
      connectionRevision: 1,
      protocol: 'chat-completions',
      deployment: 'primary',
      modelVersion: 'fixture-non-luna',
      upstreamEndpoint: null,
      capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
      qualification: { id: 'fixture', evidence: 'Synthetic only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 1 },
      access: { state: 'ready', evidence: 'Synthetic only', validUntil: until, availableRequests: 10 },
      privacy: {
        connectionRevision: 1,
        modelVersion: 'fixture-non-luna',
        protocol: 'chat-completions',
        evidence: 'Synthetic only',
        validUntil: until,
        ingressCountries: ['US'],
        decryptionCountries: ['US'],
        processingCountries: ['US'],
        retentionPolicy: 'fixture-zdr',
        zeroRetention: true,
        training: false,
        contentLogging: false,
        caching: 'off',
        transientCacheEvidence: null,
        features: ['text', 'tools'],
        allowedRetentionModes: [],
        effectiveRetentionMode: null,
        regionalEntitlement: false,
      },
      health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Synthetic only' },
      price: {
        version: 'fixture-v1',
        observedAt: at,
        validUntil: until,
        evidence: 'Synthetic only',
        inputMicroUsdPerMillion: 100_000,
        outputMicroUsdPerMillion: 200_000,
        reasoningMicroUsdPerMillion: 200_000,
        cacheReadMicroUsdPerMillion: 10_000,
        cacheWriteMicroUsdPerMillion: 125_000,
        requestFeeMicroUsd: 2,
        longContext: [],
      },
    };
    await cloudApi('POST', '/ops/routes', routing, {
      id: 'primary',
      provider: 'azure-openai',
      model: 'fixture-non-luna',
      label: 'Fixture',
      region: 'US',
      processing: 'Synthetic only',
      status: 'qualified',
      evidence: 'Synthetic only',
      binding,
    });
    const tier = { primary: 'primary', backups: [], fallbackEnabled: false, maxAttempts: 1, cost: { sameOrLower: true, qualityFloor: 1, maxAttemptMicroUsd: null } };
    await cloudApi('POST', '/ops/routing/scopes/publish', routing, {
      scope: { kind: 'global' },
      baseRevision: 1,
      baseGlobalRevision: 1,
      routing: { efficient: tier, focused: tier, thorough: tier },
      note: 'Synthetic S3 end-to-end test',
    });
    const person = await token(DEMO_ACCOUNTS.free.email);
    const personId = (await cloud.accounts.signIn(person)).person.id;
    await cloud.commercial.issuePersonGrant(billing, personId, {
      planId: 'individual',
      source: 'subscription',
      reference: 'inv_s3_fixture',
      note: 'Synthetic test entitlement.',
    });
    const client = new ControlPlaneClient('http://faux.local', (request: Request) => cloud.handle(request));
    const individual = await client.individualAccount(person);
    await cloudApi('POST', `/ops/individuals/${individual.id}/grants`, billing, { reference: 'Synthetic managed usage', validUntil: until, credits: 100 });
    await client.acceptRoutingPreference(person, {
      scope: { kind: 'individual', id: individual.id },
      baseRevision: 0,
      profile: 'balanced',
      restrictions: NO_TRAINING_RESTRICTIONS,
      consentVersion: ROUTING_CONSENT_VERSION,
      exceptions: [],
      acknowledge: true,
    });
    await ok('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.free.email, password: FAUX_DEMO_PASSWORD, remember: false });
    await app.locals.accounts.reload();
    return personId;
  }

  async function personalProject() {
    const made = await ok<{ id: string; folder: string }>('/projects', 'POST', { name: 'Linen orders' });
    await fs.writeFile(path.join(made.folder, 'delivery.md'), DELIVERY);
    const policy = await ok<{ version: number }>(`/projects/${made.id}/cloud-sharing`);
    await ok(`/projects/${made.id}/cloud-sharing`, 'PUT', {
      expectedVersion: policy.version,
      routes: ['nectovia', 'codex'],
      documents: ['delivery.md'],
      shareConversationHistory: false,
      shareReviewPackets: false,
    });
    const store = app.locals.store as Store;
    await store.saveSettings({ ...store.settings, services: { ...(store.settings.services ?? {}), codex: true, codexModel: 'gpt-codex-test' } });
    const task = await ok<{ id: string }>(`/projects/${made.id}/tasks`, 'POST', { name: 'Check the linen delivery' });
    return { projectId: made.id, taskId: task.id };
  }

  test('the lead spends credits, the worker runs on the person’s plan, and the job records both', async () => {
    await individualPerson();
    const { projectId, taskId } = await personalProject();
    // Off until the person turns it on.
    expect((await ok('/settings/subscription-workers')).preference).toBeNull();
    await ok('/settings/subscription-workers', 'PUT', { ...ON, engines: ['codex'] });
    const commandId = 's3-e2e-1';
    const started = await api(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1,
      commandId,
      taskId,
      goal: 'Find what is short in the linen delivery.',
      route: 'nectovia',
      consent: true,
      workerConsent: { revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION, engines: ['codex'] },
      sources: ['delivery.md'],
    });
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    const runId = loopRunId(projectId, commandId);
    await vi.waitFor(
      async () => expect(['completed', 'failed', 'cancelled', 'reconcile_required']).toContain((await app.locals.harness.get(projectId, runId)).state),
      { timeout: 20_000 },
    );
    await app.locals.harness.bridge.flush();
    const run = await app.locals.harness.get(projectId, runId);
    expect(run.state, JSON.stringify({ failure: run.failure, cancel: run.cancelReason })).toBe('completed');
    expect(run.input.subscriptionWorker).toMatchObject({ state: 'attached', route: 'codex' });
    // The worker's one turn went to Codex with its file, and never through the gateway.
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ route: 'codex', documents: [{ path: 'delivery.md' }] });
    expect(gatewayBodies).toHaveLength(3);
    // The worker carries the paid Agent record under the lead's job; the lead its managed one.
    const external = admissions.filter((item) => item.routeKind === 'external-engine');
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({ surface: 'loop', rootJobId: run.input.rootJobId });
    expect(admissions.some((item) => item.routeKind === 'managed')).toBe(true);
    // The job's record says who paid for what.
    const view = await ok<{ team: { leadPayer: string; workers: { payer: string; execution: string; usage: { confidence: string } }[] } }>(
      `/projects/${projectId}/loop/runs/${runId}`,
    );
    expect(view.team.leadPayer).toBe('nectovia-credits');
    expect(view.team.workers).toHaveLength(1);
    expect(view.team.workers[0]).toMatchObject({ payer: 'person-subscription', execution: 'external-proposal', usage: { confidence: 'unknown' } });
  }, 60_000);

  test('a plan the account service no longer confirms fails the worker before its turn (A29, N23)', async () => {
    await individualPerson();
    const { projectId, taskId } = await personalProject();
    await ok('/settings/subscription-workers', 'PUT', { ...ON, engines: ['codex'] });
    // The lead was admitted; the worker's own admission is refused by the account service.
    const gate = engines.agentGate!;
    const real = gate.check.bind(gate);
    vi.spyOn(gate, 'check').mockImplementation(async (work) => {
      if (work.routeKind === 'external-engine') throw new ApiError(409, 'Your Individual plan ended, so the Nectovia Agent can’t start this work.');
      return real(work);
    });
    const commandId = 's3-e2e-lapsed';
    const started = await api(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1,
      commandId,
      taskId,
      goal: 'Find what is short in the linen delivery.',
      route: 'nectovia',
      consent: true,
      workerConsent: { revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION, engines: ['codex'] },
      sources: ['delivery.md'],
    });
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    const runId = loopRunId(projectId, commandId);
    await vi.waitFor(
      async () => expect(['completed', 'failed', 'cancelled', 'reconcile_required']).toContain((await app.locals.harness.get(projectId, runId)).state),
      { timeout: 20_000 },
    );
    await app.locals.harness.bridge.flush();
    expect(sends).toEqual([]);
    const view = await ok<{ team: { workers: { outcome: string; reason: string | null }[] } }>(`/projects/${projectId}/loop/runs/${runId}`);
    expect(view.team.workers[0]?.reason ?? '').toMatch(/Individual plan ended/);
  }, 60_000);
});
