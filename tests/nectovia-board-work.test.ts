/**
 * Nectovia managed single-agent loops: the admitted path.
 *
 * EngineService admits `surface: 'loop'` on Nectovia only under a proper
 * stable root job (the loop's deterministic run id); without one it refuses
 * before the Agent gate and records nothing. The loop adapter re-admits and
 * re-opens immediately before every model step with the pinned
 * route/model/account, the original run id as the root job and the same job
 * ledger, so a revoked membership, a moved policy or an emptied cap fails
 * before the next dispatch. The start route resolves the managed
 * model/account through `resolveManaged`, bypasses the Settings switch for
 * Nectovia only, refuses conflicting user-supplied model/account and any
 * delegate or team, and offers Nectovia read-only without recording a paid
 * admission. Nothing here reaches a provider network or the account service.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EngineService } from '../server/engines/service';
import { nectoviaConnectionId } from '../server/engines/nectovia';
import { GPT6_LUNA, NECTOVIA_ROUTE } from '../shared/model-api.js';
import { dollars } from '../shared/managed-usage.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { NATIVE_LOOP_CAPABILITY } from '../shared/native-loop.js';
import {
  NECTOVIA_LOOP_TEAM_REFUSED,
  loopRunId,
  mountNativeLoopRoutes,
} from '../server/native-loop-routes';
import { Store } from '../server/store';
import { ApiError } from '../server/paths.js';
import { responsesAnswer } from './fixtures/model-api-streams.js';

const MODEL = GPT6_LUNA.model;
const ORG = 'org_juniper';
const ACCOUNT_ROUTE = `${NECTOVIA_ROUTE}:${ORG}`;
const TOKEN = 'session-access-token-test-only-0123456789';
const BASE = 'https://accounts.nectovia.test';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const POLICY = { revision: 7, tiers: { efficient: { model: MODEL, label: 'GPT-6 Luna' }, focused: null, thorough: null } } as any;

const USAGE = {
  input_tokens: 1_200,
  input_tokens_details: { cached_tokens: 200 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 120 },
  total_tokens: 1_500,
};
const envelope = (text: string) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: MODEL,
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
    { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
  ],
  usage: USAGE,
  incomplete_details: null,
  error: null,
});
const answer = (text: string) => responsesAnswer(envelope(text), 200, { 'x-nectovia-attempt': 'gw-attempt-1' });

function gateway(script: Array<(sent: { url: string; headers: Headers; body: any }) => Response>) {
  const sent: { url: string; headers: Headers; body: any }[] = [];
  const fetch = (async (input: any, init?: any) => {
    const record = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    sent.push(record);
    const next = script.shift();
    if (!next) throw new Error('No scripted gateway answer left.');
    return next(record);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

interface AdapterHarness {
  engines: EngineService;
  exposure: SpendExposure;
  account: any;
  gate: { calls: number; refuse: boolean };
  providerCalls: () => number;
  gatewayCalls: { fetch: typeof globalThis.fetch; sent: { url: string; headers: Headers; body: any }[] };
}

async function adapterHarness(root: string, script: Array<(sent: any) => Response>): Promise<AdapterHarness> {
  const engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const exposure = new SpendExposure(dataDir);
  await exposure.init();
  const connectionId = nectoviaConnectionId(ORG, NOW);
  await exposure.setCap(connectionId, dollars(100), { approvedBy: 'test', note: 'loop guard' });
  const gw = gateway(script);
  let providerCalls = 0;
  const account = {
    base: BASE,
    signedIn: () => true,
    token: async () => TOKEN,
    policy: () => ({ ...POLICY }),
    refreshPolicy: async () => ({ ...POLICY }),
    organizationFor: () => ORG,
    fetch: gw.fetch,
  };
  const gate = { calls: 0, refuse: false };
  (engines as any).agentGate = {
    check: async (work: any) => {
      gate.calls += 1;
      if (gate.refuse) {
        const { EngineError } = await import('../server/engines/process.js');
        throw new EngineError('ROUTE_REFUSED', 'This business does not include the Nectovia Agent. Nothing was charged.', true);
      }
      if (work.surface !== 'loop' || work.rootJobId == null) throw new Error('loop admission must name its root job');
      return {
        admissionId: 'adm_loop_0001',
        organizationId: ORG,
        personId: 'person_owner',
        planId: 'business',
        policyRevision: POLICY.revision,
        routeKind: 'managed',
        surface: 'loop',
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  (engines as any).modelApi = {
    connections: {},
    secrets: { available: () => false, get: async () => { throw new Error('no stored key on this route'); } },
    exposure,
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-nectovia'), NECTOVIA_ROUTE),
    nectovia: { account, transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-nectovia'), NECTOVIA_ROUTE), now: () => NOW },
    transport: (async () => {
      providerCalls += 1;
      throw new Error('No provider network on the Nectovia route');
    }) as typeof globalThis.fetch,
  };
  return { engines, exposure, account, gate, providerCalls: () => providerCalls, gatewayCalls: gw as any };
}

const modelRequest = (runId: string, text = 'Check the order.') => ({
  runId,
  capabilityId: NATIVE_LOOP_CAPABILITY,
  messages: [{ role: 'user', text }],
  tools: [],
  transcript: null,
});

describe('the Nectovia loop adapter re-admits every step under one job', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-nectovia-board-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('two model steps send under the same root job; no provider network', async () => {
    const h = await adapterHarness(root, [() => answer('count one'), () => answer('count two')]);
    const runId = 'R0123456789ab';
    const stop = new AbortController().signal;
    const adapter = await h.engines.loopAdapter(
      NECTOVIA_ROUTE,
      { projectId: 'proj_1', runId, model: MODEL, accountRoute: ACCOUNT_ROUTE, instructions: 'Check the order.' },
      stop,
    );
    expect(adapter.contract.routeId).toBe(NECTOVIA_ROUTE);
    const first = await adapter.complete(modelRequest(runId, 'Check the order.') as any, new AbortController().signal);
    const second = await adapter.complete(modelRequest(runId, 'Check the order follow-up.') as any, new AbortController().signal);
    expect(first.response).toMatchObject({ type: 'final' });
    expect(second.response).toMatchObject({ type: 'final' });
    const sent = (h.gatewayCalls as any).sent as { url: string; headers: Headers }[];
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.url).toBe(`${BASE}/managed/v1/responses`);
      expect(call.headers.get('x-nectovia-job')).toBe(runId);
      expect(call.headers.get('x-nectovia-admission')).toBe('adm_loop_0001');
      expect(call.headers.get('x-nectovia-organization')).toBe(ORG);
      expect(call.headers.get('x-nectovia-usage-class')).toBe('metered-work');
    }
    // One admission per step, all under the same job; the attempts differ.
    expect(h.gate.calls).toBeGreaterThanOrEqual(2);
    expect(sent[0].headers.get('x-nectovia-attempt')).not.toBe(sent[1].headers.get('x-nectovia-attempt'));
    // No provider network: the BYO transport would throw, and it was never called.
    expect(h.providerCalls()).toBe(0);
  });

  test('a revoked membership fails before the next dispatch; the gateway sees one call', async () => {
    const h = await adapterHarness(root, [() => answer('count one'), () => answer('count two')]);
    const runId = 'R0123456789ab';
    const stop = new AbortController().signal;
    const adapter = await h.engines.loopAdapter(
      NECTOVIA_ROUTE,
      { projectId: 'proj_1', runId, model: MODEL, accountRoute: ACCOUNT_ROUTE, instructions: 'Check the order.' },
      stop,
    );
    await adapter.complete(modelRequest(runId, 'Check the order.') as any, new AbortController().signal);
    h.gate.refuse = true;
    await expect(adapter.complete(modelRequest(runId, 'Check the order follow-up.') as any, new AbortController().signal)).rejects.toThrow();
    expect(((h.gatewayCalls as any).sent as unknown[])).toHaveLength(1);
  });

  test('a stale policy refuses honestly on the next step; nothing switches payer', async () => {
    const h = await adapterHarness(root, [() => answer('count one')]);
    const runId = 'R0123456789ab';
    const stop = new AbortController().signal;
    const adapter = await h.engines.loopAdapter(
      NECTOVIA_ROUTE,
      { projectId: 'proj_1', runId, model: MODEL, accountRoute: ACCOUNT_ROUTE, instructions: 'Check the order.' },
      stop,
    );
    await adapter.complete(modelRequest(runId, 'Check the order.') as any, new AbortController().signal);
    const moved = { revision: 8, tiers: { efficient: { model: 'us.openai.gpt-9-nova', label: 'GPT-9 Nova' }, focused: null, thorough: null } } as any;
    h.account.policy = () => ({ ...moved, tiers: { ...moved.tiers } });
    h.account.refreshPolicy = async () => ({ ...moved, tiers: { ...moved.tiers } });
    await expect(adapter.complete(modelRequest(runId, 'Check the order follow-up.') as any, new AbortController().signal)).rejects.toThrow(/Nectovia now runs/);
    expect(((h.gatewayCalls as any).sent as unknown[])).toHaveLength(1);
  });
});

describe('the loop start route runs Nectovia managed single-agent only', () => {
  let root: string;
  let store: Store;
  let app: express.Express;
  let server: Server | undefined;
  let base: string;
  let projectId: string;
  let taskId: string;
  let admitManagedCalls: { projectId: string; runId: string }[];
  let loopAdmitCalls: unknown[];

  const headers = { 'Content-Type': 'application/json' };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-nectovia-start-'));
    admitManagedCalls = [];
    loopAdmitCalls = [];
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    const project = await store.createProject('Juniper board');
    projectId = project.id;
    taskId = await store.locked(async () => {
      const task = store.createTask(store.state(projectId), { name: 'Check the order' });
      const state = store.state(projectId);
      state.cloudSharing = {
        version: 1,
        routes: [NECTOVIA_ROUTE] as any,
        documents: [],
        shareConversationHistory: false,
        shareReviewPackets: false,
      };
      await store.persist(state);
      return task.id;
    });
    const runs = new Map<string, any>();
    const sessions = new Map<string, any>();
    const harness: any = {
      get: async (_projectId: string, runId: string) => {
        const run = runs.get(runId);
        if (!run) throw new ApiError(404, 'not found');
        return run;
      },
      list: async () => [...runs.values()],
      bridge: {
        start: async (pid: string, tid: string, capabilityId: string, goal: string, _principal: unknown, _u: unknown, opts: any) => {
          const runId = opts.runId as string;
          const session = { id: `sess-${runId}`, projectId: pid };
          sessions.set(session.id, session);
          runs.set(runId, { id: runId, capabilityId, sessionId: session.id, taskId: tid, projectId: pid, input: opts.input, state: 'running' });
          return session;
        },
      },
      loop: {
        admit: async (route: string, input: unknown) => {
          loopAdmitCalls.push({ route, input });
          throw new ApiError(409, `unexpected paid admission for ${route}`);
        },
        children: async () => [],
        teamView: async () => null,
        changeSets: { views: async () => [], diff: async () => ({}) },
      },
      scrub: (value: unknown) => value,
      redact: (value: string) => value,
    };
    app = express();
    app.use(express.json());
    mountNativeLoopRoutes(app, store as any, harness as any, {} as any, null, () => true, {
      resolveManaged: () => ({ model: MODEL, accountRoute: ACCOUNT_ROUTE }),
      readOnly: () => ({ admitted: true, model: MODEL, reason: null }),
      admitManaged: async (pid: string, runId: string, input: { model: string; accountRoute: string }) => {
        admitManagedCalls.push({ projectId: pid, runId });
        return input;
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    app.use(((error: any, _req: any, res: any, _next: any) => {
      const status = typeof error?.status === 'number' ? error.status : 500;
      res.status(status).json({ error: error?.message ?? 'failed', code: error?.code ?? null });
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

  async function start(extra: Record<string, unknown>, commandId = 'board-loop-1') {
    const response = await fetch(`${base}/api/projects/${projectId}/loop/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 1,
        commandId,
        taskId,
        goal: 'Read the order and report the count.',
        route: NECTOVIA_ROUTE,
        consent: true,
        sources: [],
        ...extra,
      }),
    });
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : null) as any };
  }

  test('one run admitted under its deterministic id; a replay admits nothing new', async () => {
    const first = await start({});
    expect(first.status).toBe(200);
    expect(first.json.runId).toBe(loopRunId(projectId, 'board-loop-1'));
    expect(first.json.replayed).toBe(false);
    expect(admitManagedCalls).toEqual([{ projectId, runId: loopRunId(projectId, 'board-loop-1') }]);
    expect(loopAdmitCalls).toEqual([]);
    const second = await start({});
    expect(second.status).toBe(200);
    expect(second.json.runId).toBe(first.json.runId);
    expect(second.json.replayed).toBe(true);
    expect(admitManagedCalls).toHaveLength(1);
  });

  test('no delegate, no team, no conflicting model or account; Settings switch bypassed', async () => {
    // The store has no `nectovia: true` switch; the managed loop starts anyway.
    expect((store.settings.services as Record<string, unknown> ?? {}).nectovia).not.toBe(true);
    for (const extra of [
      { delegate: { route: 'native-fixture' } },
      { team: { scope: null, worker: { route: 'native-fixture' }, advisor: null } },
      { model: 'us.openai.gpt-9-nova' },
      { accountRoute: 'nectovia:org_other' },
    ]) {
      const refused = await start(extra, `board-refuse-${JSON.stringify(extra).length}-${Math.random().toString(36).slice(2)}`);
      expect(refused.status).toBe(409);
    }
    const delegate = await start({ delegate: { route: 'native-fixture' } }, 'board-delegate-1');
    expect(delegate.json.error).toBe(NECTOVIA_LOOP_TEAM_REFUSED);
  });

  test('the routes offer includes Nectovia read-only and records no paid admission', async () => {
    const response = await fetch(`${base}/api/projects/${projectId}/loop/routes`, { headers });
    expect(response.status).toBe(200);
    const offers = (await response.json()) as { routes: { route: string; admitted: boolean; model: string | null }[] };
    const nectovia = offers.routes.find((row) => row.route === NECTOVIA_ROUTE);
    expect(nectovia).toMatchObject({ admitted: true, model: MODEL });
    expect(admitManagedCalls).toEqual([]);
    expect(loopAdmitCalls).toEqual([]);
  });
});
