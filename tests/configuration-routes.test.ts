/**
 * The configuration HTTP surface, proven through a real Express host.
 *
 * `server/app.ts` is not edited by this slice, so the test builds the host the
 * way the real one is built — JSON parsing, the mounted routes, and the same
 * error middleware that turns an `ApiError` into its status and code — and
 * runs it on a loopback port against a real Store, WorkspaceService, Agent
 * registry and ConfigurationService over a temporary directory.
 *
 * The intake itself is completed through the workspace service rather than the
 * HTTP surface, so these tests stay about the configuration routes and do not
 * re-prove the questionnaire.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { Store } from '../server/store.js';
import { WorkspaceService } from '../server/workspaces.js';
import { AgentRegistry } from '../server/agents.js';
import { ConfigurationService } from '../server/configuration.js';
import { mountConfigurationRoutes } from '../server/configuration-routes.js';
import { ApiError } from '../server/paths.js';
import type { ConfigurationView } from '../shared/configuration.js';
import type { AnswerValue, BusinessSetupView } from '../shared/business-setup.js';

let server: Server | undefined;
let root = '';
let url = '';
let store: Store;
let workspaces: WorkspaceService;
let agents: AgentRegistry;
let configuration: ConfigurationService;

const headers = { 'Content-Type': 'application/json' };

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

/** Mirror of the host's error middleware, down to the shape it answers with. */
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message, ...error.details });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'The local service could not complete this action.' });
};

async function launch() {
  const app = express();
  app.use(express.json({ limit: '9mb' }));
  mountConfigurationRoutes(app, store, workspaces, configuration, agents);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function stop() {
  if (!server) return;
  const current = server;
  server = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'configuration-routes-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  workspaces = new WorkspaceService(store);
  await workspaces.init();
  agents = new AgentRegistry(store.dataDir);
  configuration = new ConfigurationService(store, workspaces, agents);
  await configuration.init();
  await launch();
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

async function createOrg(name = 'Ridge Cabinetry'): Promise<string> {
  const view = await workspaces.createOrganization({ name });
  return view.organizations[0]!.organization.id;
}

const configurationOf = (organizationId: string) =>
  request<ConfigurationView>(`/api/workspace/organizations/${organizationId}/configuration`);

const compile = (organizationId: string, body: object = {}) =>
  request<ConfigurationView>(
    `/api/workspace/organizations/${organizationId}/configuration/compile`,
    'POST',
    body,
  );

const activate = (organizationId: string, body: object) =>
  request<ConfigurationView>(
    `/api/workspace/organizations/${organizationId}/configuration/activate`,
    'POST',
    body,
  );

const CANNED: Record<string, AnswerValue> = {
  name: 'Ridge Cabinetry',
  industry: 'cabinetry',
  job: 'recurring-report',
  result: 'A weekly brief a person reads before anything is used.',
  sources: ['files'],
  people: 'just-me',
  'human-required': ['everything'],
  'data-leaving': 'no',
  host: 'The office desktop, weekdays.',
  'spend-cap': 100,
  'first-run': 'manual',
};

/** Answer every visible question, in the step order the host itself chooses. */
async function completeIntake(organizationId: string): Promise<void> {
  await workspaces.startSetup(organizationId, 'start');
  let view = workspaces.setupView(organizationId);
  for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1) {
    view = await workspaces.answer(organizationId, {
      questionId: view.step,
      value: CANNED[view.step] ?? null,
    });
  }
  if (!view.ready) throw new Error('The test intake did not complete.');
}

const errorCode = (data: unknown): string | undefined => (data as { code?: string } | null)?.code;

describe('the configuration view', () => {
  test('an organization with nothing configured shows an empty, explainable view', async () => {
    const organizationId = await createOrg();
    const { status, data } = await configurationOf(organizationId);
    expect(status).toBe(200);
    expect(data.active).toBeNull();
    expect(data.staged).toBeNull();
    expect(data.canActivate).toBe(false);
    expect(data.whyNot).toMatch(/no staged setup/i);
  });
});

describe('compile', () => {
  test('refuses while the questionnaire is unfinished', async () => {
    const organizationId = await createOrg();
    const { status, data } = await compile(organizationId);
    expect(status).toBe(409);
    expect(errorCode(data)).toBe('setup_incomplete');
  });

  test('stages revision one with every change new once the questionnaire is finished', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    const { status, data } = await compile(organizationId);
    expect(status).toBe(200);
    expect(data.staged?.revision).toBe(1);
    expect(data.active).toBeNull();
    expect(data.changes.length).toBeGreaterThan(0);
    expect(data.changes.every((change) => change.kind === 'new')).toBe(true);
  });

  test('accepts a known variant and refuses an unknown one', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    const chosen = await compile(organizationId, { variantId: 'restaurant-operations' });
    expect(chosen.status).toBe(200);
    expect(chosen.data.staged?.proposal.template.variantId).toBe('restaurant-operations');
    const unknown = await compile(organizationId, { variantId: 'industrial' });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown.data)).toBe('invalid_variant');
  });

  test('a proposal in the body is refused rather than honoured', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    const refused = await compile(organizationId, { proposal: { v: 1, agents: [] } });
    expect(refused.status).toBe(400);
    // The host builds proposals; receiving one would be the executable setup
    // the contract refuses, so nothing may have been staged by the attempt.
    expect((await configurationOf(organizationId)).data.staged).toBeNull();
  });
});

describe('activate', () => {
  test('refuses a malformed request in every dimension', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    await compile(organizationId);
    for (const body of [
      { revision: 1, expectedActiveRevision: null },
      { expectedActiveRevision: null, activationId: 'act-1' },
      { revision: 0, expectedActiveRevision: null, activationId: 'act-1' },
      { revision: 1, expectedActiveRevision: null, activationId: 'x'.repeat(200) },
    ]) {
      const attempt = await activate(organizationId, body);
      expect(attempt.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(attempt.data)).toBe('invalid_activation');
    }
  });

  test('the staged revision becomes active and the expected revision moves with it', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    const staged = (await compile(organizationId)).data;
    expect(staged.staged?.revision).toBe(1);
    expect(staged.canActivate).toBe(true);
    expect(staged.expectedActiveRevision).toBeNull();
    const { status, data } = await activate(organizationId, {
      revision: 1,
      expectedActiveRevision: staged.expectedActiveRevision,
      activationId: 'first-activation',
    });
    expect(status).toBe(200);
    expect(data.active?.revision).toBe(1);
    expect(data.active?.state).toBe('active');
    expect(data.expectedActiveRevision).toBe(1);
  });

  test('repeating the identical activation returns the recorded result and creates nothing', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    await compile(organizationId);
    const body = { revision: 1, expectedActiveRevision: null, activationId: 'replay-check' };
    const first = await activate(organizationId, body);
    expect(first.status).toBe(200);
    const again = await activate(organizationId, body);
    expect(again.status).toBe(200);
    expect(again.data.active?.revision).toBe(first.data.active?.revision);
    // A replayed request leaves exactly one manifest behind: no second
    // revision, no second preparation.
    expect(configuration.history(organizationId)).toHaveLength(1);
  });

  test('a stale expected active revision conflicts instead of switching', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    await compile(organizationId);
    const activated = await activate(organizationId, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'stale-test-1',
    });
    expect(activated.data.expectedActiveRevision).toBe(1);
    const next = await compile(organizationId);
    expect(next.data.staged?.revision).toBe(2);
    const stale = await activate(organizationId, {
      revision: 2,
      expectedActiveRevision: null,
      activationId: 'stale-test-2',
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale.data)).toBe('stale_configuration');
    // The refusal changed nothing: the old setup is still active.
    expect((await configurationOf(organizationId)).data.active?.revision).toBe(1);
  });
});

describe('the store lock', () => {
  test('concurrent compiles queue instead of staging two manifests at one revision', async () => {
    const organizationId = await createOrg();
    await completeIntake(organizationId);
    // Without the per-route lock both compiles would read an empty manifest
    // list and both stage revision 1.
    const [first, second] = await Promise.all([compile(organizationId), compile(organizationId)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(configuration.history(organizationId).map((manifest) => manifest.revision)).toEqual([
      2, 1,
    ]);
  });
});
