import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, HOST_TEST_PROJECT, TESTED_VERSIONS } from '../server/engines/service.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { textResponse } from './h01-fixture.js';
import type { AdapterInspection, TextRequest, TextResponse } from '../server/engines/contract.js';
import type { DiscoveredInstallation } from '../server/discovery.js';
import type { EngineConnection } from '../shared/engines.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';
import type { HarnessRun } from '../shared/harness.js';

/**
 * The connection test as the packaged application actually runs it: the real
 * `createApp` wiring, so the durable run goes through `ProjectRunStore` and
 * `HarnessBridge` rather than a test's own `FileRunStore`. A run Diomedes
 * starts for itself belongs to no customer project, and the production store
 * used to refuse it for exactly that reason.
 *
 * Only the provider transport and what this computer reports about the
 * installation are scripted. Everything between the HTTP route and the run
 * file on disk is the shipped path.
 */
const ENGINE: ExternalEngine = 'opencode';
const VERSION = TESTED_VERSIONS[ENGINE];
const ROUTE = 'opencode:go';
const ANSWER = 'ok-9d13-reply';
const MODELS = [
  { slug: 'small', name: 'Small', description: '', efforts: [], defaultEffort: null },
  { slug: 'large', name: 'Large', description: '', efforts: [], defaultEffort: null },
];

const cleanups: (() => Promise<void>)[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporary() {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-wiring-'));
  roots.push(made);
  return made;
}

const dataDir = (root: string) => path.join(root, 'data');
/** Where a run Diomedes started for itself belongs. */
const hostRuns = (root: string) =>
  path.join(dataDir(root), 'host', HOST_TEST_PROJECT, 'harness', 'runs');
const projectRuns = (root: string, projectId: string) =>
  path.join(dataDir(root), 'projects', projectId, 'harness', 'runs');
const listRuns = (dir: string) => {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
};
const readRun = (dir: string, name: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as HarnessRun;

interface Options {
  /** A provider transport that replaces the ordinary scripted answer. */
  generate?: (input: TextRequest) => Promise<TextResponse>;
}

/** One running Diomedes service over `root`, built the way the desktop builds it. */
async function open(root: string, options: Options = {}) {
  const tool = path.join(root, 'tools', 'opencode.exe');
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  if (!fs.existsSync(tool)) fs.writeFileSync(tool, 'opencode');
  const inspection: AdapterInspection = {
    authentication: 'signed-in',
    accountRoute: ROUTE,
    models: MODELS.map((row) => ({ ...row })),
    detail: 'Checked',
  };
  const generate = vi.fn<(input: TextRequest) => Promise<TextResponse>>(
    options.generate ?? (async (input) => textResponse(input, ANSWER, VERSION)),
  );
  const row: IntegrationStatus = {
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
    location: tool,
    disclosure: [],
  };
  const installation: DiscoveredInstallation = {
    engine: ENGINE,
    path: tool,
    context: 'windows-native',
  };
  const engineService = new EngineService(path.join(dataDir(root), 'engines'), {
    discover: async (scope) => (!scope?.engine || scope.engine === ENGINE ? [row] : []),
    enumerate: async (scope) =>
      !scope?.engine || scope.engine === ENGINE ? [installation] : [],
    version: async () => VERSION,
    buildId: () => 'wiring-build',
    adapter: (id) => ({
      id,
      contract: routeContractFor(id),
      inspect: async () => structuredClone(inspection),
      generate,
    }),
  });
  const app = await createApp({
    dataDir: dataDir(root),
    projectRoot: path.join(root, 'projects'),
    engineService,
  });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const close = async () => {
    await app.locals.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  let shut = false;
  const shutdown = async () => {
    if (shut) return;
    shut = true;
    await close();
  };
  cleanups.push(shutdown);
  const post = (route: string, body: unknown) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: JSON.stringify(body),
    });
  const get = (route: string) => fetch(`${base}${route}`);
  const connection = async (): Promise<EngineConnection> =>
    ((await (await get('/ai/status')).json()) as { connections: EngineConnection[] }).connections
      .find((row) => row.engine === ENGINE)!;
  /** The ordinary setup a person finishes before a test is offered at all. */
  const settle = async (model = 'small') => {
    expect((await post('/ai/discover', { consent: true })).status).toBe(200);
    expect((await post(`/ai/check/${ENGINE}`, {})).status).toBe(200);
    expect((await post('/ai/select', { engine: ENGINE, model })).status).toBe(200);
  };
  return { post, get, connection, settle, generate, shutdown };
}

describe('a host-initiated connection test through the production wiring', () => {
  it('answers, records a receipt for the selected revision, and keeps the run out of every project', async () => {
    const root = temporary();
    const app = await open(root);
    await app.settle();
    const before = await app.connection();

    const response = await app.post(`/ai/test/${ENGINE}`, { consent: true, model: 'small' });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      receipt: Record<string, unknown>;
      connection: EngineConnection;
    };
    expect(payload.receipt).toMatchObject({
      engine: ENGINE,
      revision: before.revision,
      candidateId: before.binding!.id,
      version: VERSION,
      accountRoute: ROUTE,
      model: 'small',
      buildId: 'wiring-build',
    });
    expect(app.generate).toHaveBeenCalledTimes(1);
    expect(payload.connection.verification).toMatchObject({
      runId: payload.receipt.runId as string,
    });

    // The durable run is under the reserved host folder, completed, and the
    // receipt names it.
    const runId = payload.receipt.runId as string;
    expect(runId.startsWith(`${HOST_TEST_PROJECT}-test-`)).toBe(true);
    expect(listRuns(hostRuns(root))).toEqual([`${runId}.json`]);
    const run = readRun(hostRuns(root), `${runId}.json`);
    expect(run).toMatchObject({ projectId: HOST_TEST_PROJECT, state: 'completed' });

    // And the receipt Diomedes returned is already on disk.
    const receipts = path.join(dataDir(root), 'engines', 'receipts.json');
    expect(JSON.parse(fs.readFileSync(receipts, 'utf8'))).toMatchObject({
      engines: { [ENGINE]: { runId, model: 'small', accountRoute: ROUTE } },
    });
  });

  it('shows the same receipt after a restart against the same data folder', async () => {
    const root = temporary();
    const first = await open(root);
    await first.settle();
    const runId = (
      (await (await first.post(`/ai/test/${ENGINE}`, { consent: true, model: 'small' })).json()) as {
        receipt: { runId: string };
      }
    ).receipt.runId;
    await first.shutdown();

    const again = await open(root);
    // History reloaded; nothing about the live route is claimed yet.
    const reopened = await again.connection();
    expect(reopened.verification).toMatchObject({ runId });
    expect(reopened).toMatchObject({ installation: 'not-checked', checkedAt: null });

    expect((await again.post('/ai/discover', { consent: true })).status).toBe(200);
    expect((await again.post(`/ai/check/${ENGINE}`, {})).status).toBe(200);
    expect((await again.connection()).verification).toMatchObject({ runId });
    // The durable run itself survived the restart, still readable and still
    // belonging to no project.
    const run = readRun(hostRuns(root), `${runId}.json`);
    expect(run).toMatchObject({ id: runId, projectId: HOST_TEST_PROJECT, state: 'completed' });
    expect(again.generate).not.toHaveBeenCalled();
  });

  it('sends nothing without consent', async () => {
    const root = temporary();
    const app = await open(root);
    await app.settle();
    const response = await app.post(`/ai/test/${ENGINE}`, { model: 'small' });
    expect(response.status).toBe(409);
    expect(app.generate).not.toHaveBeenCalled();
    expect(listRuns(hostRuns(root))).toEqual([]);
  });

  it('sends nothing for a model other than the selected one', async () => {
    const root = temporary();
    const app = await open(root);
    await app.settle('small');
    const response = await app.post(`/ai/test/${ENGINE}`, { consent: true, model: 'large' });
    expect(response.status).toBe(409);
    expect(app.generate).not.toHaveBeenCalled();
    expect(listRuns(hostRuns(root))).toEqual([]);
  });

  it('leaves a customer project with no session, no history and no run of its own', async () => {
    const root = temporary();
    const app = await open(root);
    const project = (await (
      await app.post('/projects', { name: 'Customer work' })
    ).json()) as { id: string };
    await app.settle();
    expect((await app.post(`/ai/test/${ENGINE}`, { consent: true, model: 'small' })).status).toBe(
      200,
    );

    const state = (await (await app.get(`/projects/${project.id}/state`)).json()) as {
      sessions: unknown[];
      history: unknown[];
      needs: unknown[];
      tasks: unknown[];
    };
    expect(state.sessions).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.needs).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(listRuns(projectRuns(root, project.id))).toEqual([]);
    expect(listRuns(hostRuns(root))).toHaveLength(1);
  });

  it('parks a host run interrupted after dispatch instead of sending it again', async () => {
    const root = temporary();
    let release: (() => void) | undefined;
    const first = await open(root, {
      generate: async (input) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return textResponse(input, ANSWER, VERSION);
      },
    });
    await first.settle();
    const pending = first.post(`/ai/test/${ENGINE}`, { consent: true, model: 'small' });
    await vi.waitFor(() => expect(first.generate).toHaveBeenCalledTimes(1));

    // Exactly what was on disk while the provider held the request: the run is
    // running and its one external dispatch step is in flight.
    const [file] = listRuns(hostRuns(root));
    const interrupted = fs.readFileSync(path.join(hostRuns(root), file), 'utf8');
    expect(JSON.parse(interrupted)).toMatchObject({ state: 'running' });

    release!();
    expect((await pending).status).toBe(200);
    await first.shutdown();
    // The crash: the completed record never reached the disk.
    fs.writeFileSync(path.join(hostRuns(root), file), interrupted);

    const again = await open(root);
    const recovered = readRun(hostRuns(root), file);
    expect(recovered.state).toBe('reconcile_required');
    expect(
      recovered.steps.find((step) => step.intent.stepId === 'text:dispatch')!.state,
    ).toBe('reconcile_required');
    // Nothing re-sent it, and nothing claimed its outcome.
    expect(again.generate).not.toHaveBeenCalled();
  });
});
