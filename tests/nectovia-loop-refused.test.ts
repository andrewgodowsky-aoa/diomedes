/**
 * A work loop on the Nectovia route is refused before anything is admitted.
 *
 * The loop start, a delegate named on it, the harness's loop admission seam and the loop's adapter
 * all refuse the `nectovia` route with one sentence, before the Agent gate asks the account service.
 * Before this, the loop seam admitted `{ surface: 'loop', rootJobId: null }` as managed work (a
 * recorded admission at the service) and only then refused it for having no job to meter under.
 *
 * The account service is the real control-plane handler over the faux store, in this process. No
 * gateway or provider call is made anywhere in this file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { NECTOVIA_LOOP_REFUSED } from '../server/engines/nectovia';
import { testOnlySecretBox } from '../server/connection-secrets';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import type { AccountStateView } from '../shared/accounts';
import type { Project } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

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
        return new Response(JSON.stringify({ error: { code: 'unexpected', message: 'No gateway call is made in this file.' } }), { status: 500 });
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
  const taskId = (await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: 'Check the order' })).id;
  return { projectId: project.id, taskId };
}
const start = (projectId: string, taskId: string, extra: Record<string, unknown>) =>
  request(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1,
    commandId: `loop-${Math.random().toString(36).slice(2)}`,
    taskId,
    goal: 'Read the order and report the count.',
    consent: true,
    sources: [],
    ...extra,
  });

describe('a Nectovia work loop is refused before admission', () => {
  test('starting one: one plain sentence, and the service records nothing', async () => {
    const { projectId, taskId } = await projectWithTask();
    const before = await admissions();
    const refused = await start(projectId, taskId, { route: 'nectovia', model: 'us.openai.gpt-6-luna', accountRoute: `nectovia:${juniper}` });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: NECTOVIA_LOOP_REFUSED, code: 'loop_route_unsupported' });

    // Not the Settings switch either: turning a `nectovia` switch on does not make it a loop route.
    const store = app.locals.store;
    await store.saveSettings({ ...store.settings, services: { ...(store.settings.services ?? {}), nectovia: true, nectoviaModel: 'us.openai.gpt-6-luna' } });
    const again = await start(projectId, taskId, { route: 'nectovia' });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe(NECTOVIA_LOOP_REFUSED);

    // A delegate named on the Nectovia route is refused the same way, on a loop that could start.
    const delegated = await start(projectId, taskId, { route: 'native-fixture', delegate: { route: 'nectovia', model: 'us.openai.gpt-6-luna' } });
    expect(delegated.status).toBe(409);
    expect((await delegated.json()).error).toBe(NECTOVIA_LOOP_REFUSED);

    expect(await admissions(), 'no admission was recorded').toBe(before);
    expect(gatewayCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test('the route offers never list it', async () => {
    const { projectId } = await projectWithTask();
    const offers = await api<{ routes: { route: string }[] }>(`/projects/${projectId}/loop/routes`);
    expect(offers.routes.map((row) => row.route)).not.toContain('nectovia');
  });

  test('the harness’s loop admission seam refuses it before the Agent gate asks the service', async () => {
    const { projectId } = await projectWithTask();
    const before = await admissions();
    await expect(
      app.locals.harness.loop.admit('nectovia', { projectId, model: 'us.openai.gpt-6-luna', accountRoute: `nectovia:${juniper}` }),
    ).rejects.toThrow(NECTOVIA_LOOP_REFUSED);
    await expect(
      engines.admitModelApi('nectovia', { projectId, model: 'us.openai.gpt-6-luna', accountRoute: `nectovia:${juniper}` }, { surface: 'loop', rootJobId: null }),
    ).rejects.toMatchObject({ code: 'ROUTE_REFUSED', message: NECTOVIA_LOOP_REFUSED });
    expect(await admissions(), 'no admission was recorded').toBe(before);
  });

  test('a loop run driven on it opens no adapter, admits nothing and sends nothing', async () => {
    const { projectId } = await projectWithTask();
    const before = await admissions();
    await expect(
      engines.loopAdapter(
        'nectovia',
        { projectId, runId: 'loop-run-1', model: 'us.openai.gpt-6-luna', accountRoute: `nectovia:${juniper}`, instructions: 'Check the order.' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_REFUSED', message: NECTOVIA_LOOP_REFUSED });
    expect(await admissions()).toBe(before);
    expect(gatewayCalls).toBe(0);
  });

  test('control: other Nectovia work still asks the service, so the count above would move', async () => {
    const { projectId } = await projectWithTask();
    const before = await admissions();
    // The outcome after admission does not matter here; only that the gate asked the service.
    await engines
      .admitModelApi('nectovia', { projectId, model: 'us.openai.gpt-6-luna', accountRoute: `nectovia:${juniper}` }, { surface: 'conversation', rootJobId: 'turn-1' })
      .catch(() => null);
    expect(await admissions()).toBe(before + 1);
  });
});
