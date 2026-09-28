/**
 * Nectovia work loops through the real app with managed wiring.
 *
 * The app now attaches `resolveManaged`/`readOnly`/`admitManaged` (app.ts),
 * so a paid Juniper project offers Nectovia read-only with zero admissions
 * and starts a managed single-agent loop under its deterministic run id. A
 * replay of the same command id returns the same run and records nothing new;
 * every admission for the run names the same root job. A conflicting
 * user-supplied model/account, a delegate or team on either side, a missing
 * stable job and a runtime with no model API all fail closed before anything
 * is sent. A Free person and a business without the Agent are refused before
 * any model call.
 *
 * The account service is the real control-plane handler over the faux store,
 * in this process, with its default offline scripted provider. Managed calls
 * go through `cloud.handle` (counted); the BYO provider transport throws, so
 * no live network or provider is used anywhere in this file.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { NECTOVIA_LOOP_REFUSED } from '../server/engines/nectovia';
import { NECTOVIA_LOOP_TEAM_REFUSED, loopRunId } from '../server/native-loop-routes';
import { GPT6_LUNA } from '../shared/model-api.js';
import { testOnlySecretBox } from '../server/connection-secrets';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import type { AccountStateView } from '../shared/accounts';
import type { Project } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const MODEL = GPT6_LUNA.model;

let root: string;
let cloud: FauxCloud;
let juniper: string;
let engines: EngineService;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let gatewayCalls: number;
let providerCalls: number;

async function staffToken(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}
/** Every Agent admission the service has recorded for Juniper, admitted or refused. */
async function admissions() {
  return (await cloud.commercial.customer(await staffToken(DEMO_ACCOUNTS.staffBilling.email), juniper)).admissions.length;
}
async function admittedFor(rootJobId: string) {
  const rows = (await cloud.commercial.customer(await staffToken(DEMO_ACCOUNTS.staffBilling.email), juniper)).admissions;
  return rows.filter((row) => row.decision === 'admitted' && row.rootJobId === rootJobId);
}
const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-nectovia-loop-'));
  gatewayCalls = 0;
  providerCalls = 0;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', async (req) => {
      if (new URL(req.url).pathname.startsWith('/managed/v1/')) {
        gatewayCalls += 1;
        return cloud.handle(req);
      }
      return cloud.handle(req);
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
      providerCalls += 1;
      throw new Error('No provider is called in this file');
    }) as typeof globalThis.fetch,
    accounts: { backend },
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = await api<AccountStateView>('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: false });
  expect(owner.workspaces.map((row) => row.organization.id)).toContain(juniper);
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

async function projectWithTask() {
  const project = await api<Project>('/projects', 'POST', { name: 'Juniper loop' });
  await api(`/workspace/organizations/${juniper}/output`, 'POST', { projectId: project.id });
  await allowSharing(project.id);
  const taskId = (await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: 'Check the order' })).id;
  return { projectId: project.id, taskId };
}
async function allowSharing(projectId: string) {
  const policy = await api<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version, routes: ['nectovia'], documents: [],
    shareConversationHistory: false, shareReviewPackets: false,
  });
}
const start = (projectId: string, taskId: string, extra: Record<string, unknown>, commandId = `loop-${Math.random().toString(36).slice(2)}`) =>
  request(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1,
    commandId,
    taskId,
    goal: 'Read the order and report the count.',
    route: 'nectovia',
    consent: true,
    sources: [],
    ...extra,
  });

describe('a paid Nectovia work loop through managed wiring', () => {
  test('the route offers list it as available read-only without admitting anything', async () => {
    const { projectId } = await projectWithTask();
    const before = await admissions();
    const offers = await api<{ routes: { route: string; admitted: boolean; model: string | null }[] }>(`/projects/${projectId}/loop/routes`);
    const nectovia = offers.routes.find((row) => row.route === 'nectovia');
    expect(nectovia, 'Nectovia is offered').toBeDefined();
    expect(nectovia).toMatchObject({ admitted: true, model: MODEL });
    expect(await admissions(), 'reading offers records nothing').toBe(before);
    expect(gatewayCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test('one paid start under its deterministic id; a replay admits nothing new on the same job', async () => {
    const { projectId, taskId } = await projectWithTask();
    const before = await admissions();
    const commandId = 'board-loop-paid-1';
    const first = await start(projectId, taskId, {}, commandId);
    const firstText = await first.text();
    expect(first.status, firstText).toBe(200);
    const firstJson = JSON.parse(firstText) as { runId: string; replayed: boolean };
    expect(firstJson.runId).toBe(loopRunId(projectId, commandId));
    expect(firstJson.replayed).toBe(false);
    await vi.waitFor(async () => {
      const run = await app.locals.harness.get(projectId, firstJson.runId);
      expect(run.state, JSON.stringify(run.steps.map((step: { state: string; error?: unknown }) => ({ state: step.state, error: step.error })))).toBe('completed');
    }, { timeout: 20_000 });
    await app.locals.harness.bridge.flush();
    await cloud.idle();
    const completed = await app.locals.harness.get(projectId, firstJson.runId);
    expect(completed.steps.filter((step: { intent: { kind: string } }) => step.intent.kind === 'model')).toHaveLength(2);
    const admissionCount = await admissions();
    expect(admissionCount, 'start and each model call record paid admission').toBeGreaterThan(before + 1);
    const pinned = await admittedFor(firstJson.runId);
    expect(pinned).toHaveLength(admissionCount - before);
    for (const admission of pinned)
      expect(admission).toMatchObject({ decision: 'admitted', routeKind: 'managed', surface: 'loop', organizationId: juniper });
    expect(gatewayCalls).toBe(2);
    expect(providerCalls).toBe(0);

    const second = await start(projectId, taskId, {}, commandId);
    const secondText = await second.text();
    expect(second.status, secondText).toBe(200);
    const secondJson = JSON.parse(secondText) as { runId: string; replayed: boolean };
    expect(secondJson.runId).toBe(firstJson.runId);
    expect(secondJson.replayed).toBe(true);
    expect(await admissions(), 'a replay allocates no second job or paid admission').toBe(admissionCount);
    expect(await admittedFor(firstJson.runId), 'every admission names the same root job').toHaveLength(pinned.length);
    expect(gatewayCalls).toBe(2);
    expect(providerCalls).toBe(0);
  });

  test('a conflicting model or account is refused with nothing recorded', async () => {
    const { projectId, taskId } = await projectWithTask();
    const before = await admissions();
    for (const extra of [{ model: 'us.openai.gpt-9-nova' }, { accountRoute: 'nectovia:org_other' }]) {
      const refused = await start(projectId, taskId, extra);
      expect(refused.status).toBe(409);
      expect((await refused.json()) as { code: string }).toMatchObject({ code: 'route_refused' });
    }
    expect(await admissions(), 'no admission was recorded').toBe(before);
    expect(gatewayCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test('Board Work uses the paid native loop and replays its durable Work receipt', async () => {
    const { projectId, taskId } = await projectWithTask();
    await api(`/projects/${projectId}/tasks/${taskId}/workflow`, 'PUT', {
      expectedRevision: 1, continuation: 'full-approval', maxTurns: 4,
    });
    const commandId = 'managed-board-work';
    const body = { protocolVersion: 1, commandId, taskId, route: 'nectovia', consent: true,
      sources: [], instruction: 'Report the order count.' };
    const session = await api<{ id: string; engine: { name: string }; receipt: { commandId: string } }>(
      `/projects/${projectId}/work/start`, 'POST', body);
    expect(session.engine.name).toBe('diomedes-loop');
    expect(session.receipt.commandId).toBe(commandId);
    const runId = loopRunId(projectId, commandId);
    await vi.waitFor(async () => expect((await app.locals.harness.get(projectId, runId)).state).toBe('completed'), { timeout: 20_000 });
    await app.locals.harness.bridge.flush();
    await cloud.idle();
    const state = app.locals.store.state(projectId);
    expect(state.tasks.find((task: { id: string }) => task.id === taskId)!.workflow).toMatchObject({ phase: 'review', pendingPhase: null });
    const beforeReplay = await admissions();
    const replay = await api<{ id: string }>(`/projects/${projectId}/work/start`, 'POST', body);
    expect(replay.id).toBe(session.id);
    expect(state.sessions.filter((item: { taskId: string }) => item.taskId === taskId)).toHaveLength(1);
    expect(await admissions()).toBe(beforeReplay);
    expect(await admittedFor(runId)).toHaveLength(beforeReplay);
    expect(gatewayCalls).toBe(2);
    expect(providerCalls).toBe(0);
  });

  test('a delegate or team beside Nectovia is refused the same way, on either side', async () => {
    const { projectId, taskId } = await projectWithTask();
    const before = await admissions();
    // A Nectovia lead names no delegate and no team.
    for (const extra of [
      { delegate: { route: 'native-fixture' } },
      { team: { scope: null, worker: { route: 'native-fixture' }, advisor: null } },
    ]) {
      const refused = await start(projectId, taskId, extra, `board-team-${Math.random().toString(36).slice(2)}`);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe(NECTOVIA_LOOP_TEAM_REFUSED);
    }
    // Nothing names Nectovia as a delegate either, on a loop that could start.
    const delegated = await start(projectId, taskId, { route: 'native-fixture', delegate: { route: 'nectovia', model: MODEL } });
    expect(delegated.status).toBe(409);
    expect(((await delegated.json()) as { error: string }).error).toBe(NECTOVIA_LOOP_REFUSED);
    expect(await admissions(), 'no admission was recorded').toBe(before);
    expect(gatewayCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test('the harness loop seam refuses a null job before the Agent gate; a stable job admits on the same job', async () => {
    const { projectId } = await projectWithTask();
    const before = await admissions();
    await expect(
      app.locals.harness.loop.admit('nectovia', { projectId, model: MODEL, accountRoute: `nectovia:${juniper}` }),
    ).rejects.toThrow(NECTOVIA_LOOP_REFUSED);
    await expect(
      engines.admitModelApi('nectovia', { projectId, model: MODEL, accountRoute: `nectovia:${juniper}` }, { surface: 'loop', rootJobId: null }),
    ).rejects.toMatchObject({ code: 'ROUTE_REFUSED', message: NECTOVIA_LOOP_REFUSED });
    expect(await admissions(), 'the null-job refusal recorded nothing').toBe(before);

    const rootJobId = 'R0123456789ab';
    const admitted = await engines.admitModelApi(
      'nectovia',
      { projectId, model: MODEL, accountRoute: `nectovia:${juniper}` },
      { surface: 'loop', rootJobId },
    );
    expect(admitted).toMatchObject({ route: 'nectovia', model: MODEL, accountRoute: `nectovia:${juniper}` });
    expect(admitted.managed?.rootJobId).toBe(rootJobId);
    expect(await admissions(), 'the stable job recorded one admission').toBe(before + 1);
    expect(await admittedFor(rootJobId), 'the admission is pinned to the stable job').toHaveLength(1);
    expect(gatewayCalls, 'admission alone sends nothing').toBe(0);
    expect(providerCalls).toBe(0);
  });

  test('a loop run driven with no runtime stays unavailable and sends nothing', async () => {
    const { projectId } = await projectWithTask();
    const before = await admissions();
    const bare = new EngineService(path.join(root, 'engines-bare'), { discover: async () => [] });
    await expect(
      bare.loopAdapter(
        'nectovia',
        { projectId, runId: 'loop-run-1', model: MODEL, accountRoute: `nectovia:${juniper}`, instructions: 'Check the order.' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(await admissions()).toBe(before);
    expect(gatewayCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test('a Free person and a business without the Agent are refused before any model call', async () => {
    const { projectId, taskId } = await projectWithTask();
    const before = await admissions();

    await api<AccountStateView>('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.free.email, password: FAUX_DEMO_PASSWORD, remember: false });
    const freeProject = await api<Project>('/projects', 'POST', { name: 'Free loop' });
    await allowSharing(freeProject.id);
    const freeTask = (await api<{ id: string }>(`/projects/${freeProject.id}/tasks`, 'POST', { name: 'Check the order' })).id;
    const freeRefused = await start(freeProject.id, freeTask, {});
    expect([401, 403]).toContain(freeRefused.status);
    expect(await admissions(), 'a Free refusal records no Juniper admission').toBe(before);

    const harborOwner = await api<AccountStateView>('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.harborOwner.email, password: FAUX_DEMO_PASSWORD, remember: false });
    const harborId = harborOwner.workspaces[0].organization.id;
    const harborProject = await api<Project>('/projects', 'POST', { name: 'Harbor loop' });
    await api(`/workspace/organizations/${harborId}/output`, 'POST', { projectId: harborProject.id });
    await allowSharing(harborProject.id);
    const harborTask = (await api<{ id: string }>(`/projects/${harborProject.id}/tasks`, 'POST', { name: 'Count hammers' })).id;
    const harborRefused = await start(harborProject.id, harborTask, {});
    expect(harborRefused.status).toBe(403);
    expect(((await harborRefused.json()) as { code: string }).code).toBe('AGENT_NOT_INCLUDED');
    expect(await admissions(), 'a Harbor refusal records no Juniper admission').toBe(before);

    expect(gatewayCalls, 'refusals sent no model call').toBe(0);
    expect(providerCalls).toBe(0);
  });
});
