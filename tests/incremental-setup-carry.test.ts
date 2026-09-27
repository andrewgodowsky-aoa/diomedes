/**
 * ORG-02, run as the build that ships revision 2 of the questions would run it.
 *
 * `vi.mock` gives this file a build at revision 2 with one declared change,
 * `REVISION_2`: the spending cap is asked differently, the first-run question
 * is new, and a revision 1 question about a fax number is no longer asked. The
 * questions themselves are the shipped ones; only the revision and the change
 * table differ. A setup "saved by the revision 1 build" is one whose record
 * says `schemaRevision: 1`, written to disk or to the account service directly.
 *
 * The first block is a business kept on this computer, with its configuration:
 * the active configuration stays active until a new one is activated, only the
 * changed and new questions are asked, and the file as it was is kept. The
 * second is a business the account service keeps (ORG-01): a Manager resumes
 * the owner's setup, and the answers it keeps stay the owner's.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';

const { REVISION_2 } = vi.hoisted(() => ({
  REVISION_2: {
    from: 1,
    added: [{ id: 'first-run', why: 'Revision 2 asks how the first brief should start.' }],
    changed: [{ id: 'spend-cap', why: 'The cap is now a monthly amount rather than a weekly one.' }],
    removed: [{ id: 'fax-number', why: 'Briefs are no longer sent by fax.' }],
  },
}));

vi.mock('../shared/business-setup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/business-setup.js')>()),
  BUSINESS_SETUP_SCHEMA_REVISION: 2,
}));
vi.mock('../shared/setup-question-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/setup-question-changes.js')>()),
  QUESTION_SET_CHANGES: Object.freeze([REVISION_2]),
}));

import { Store } from '../server/store.js';
import { WorkspaceService } from '../server/workspaces.js';
import { AgentRegistry } from '../server/agents.js';
import { ConfigurationService } from '../server/configuration.js';
import { mountConfigurationRoutes } from '../server/configuration-routes.js';
import { ApiError } from '../server/paths.js';
import { familyProblems } from '../server/migrations/framework.js';
import { BUSINESS_SETUP } from '../server/migrations/registry.js';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import {
  BUSINESS_QUESTIONS,
  BUSINESS_SETUP_SCHEMA_REVISION,
  type AnswerValue,
  type BusinessAnswer,
  type BusinessSetup,
  type BusinessSetupView,
} from '../shared/business-setup.js';
import type { ConfigurationView } from '../shared/configuration.js';
import type { AccountStateView } from '../shared/accounts.js';
import type { WorkspaceView } from '../shared/workspaces.js';

const FAX_PROMPT = 'What fax number should briefs go to?';

const given = (questionId: string, value: AnswerValue, by: string, at: string): BusinessAnswer => ({
  questionId,
  value,
  unknown: false,
  origin: 'person',
  at,
  by,
  prompt: BUSINESS_QUESTIONS.find((question) => question.id === questionId)?.prompt ?? FAX_PROMPT,
});

test('this file runs as a build at revision 2 whose setup family carries revision 1', () => {
  expect(BUSINESS_SETUP_SCHEMA_REVISION).toBe(2);
  expect(BUSINESS_SETUP.current).toBe(2);
  expect(familyProblems(BUSINESS_SETUP)).toEqual([]);
});

// --- a business kept on this computer, with its configuration ---------------------

describe('a setup kept on this computer, saved by the revision 1 build (ORG-02)', () => {
  let root = '';
  let url = '';
  let server: Server | undefined;
  let store: Store;
  let workspaces: WorkspaceService;
  let configuration: ConfigurationService;

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message, ...error.details });
      return;
    }
    res.status(500).json({ error: String(error) });
  };

  /** Open the host on the data folder, as the app does when it starts. */
  async function boot() {
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    workspaces = new WorkspaceService(store);
    await workspaces.init();
    const agents = new AgentRegistry(store.dataDir);
    configuration = new ConfigurationService(store, workspaces, agents);
    await configuration.init();
    const app = express();
    app.use(express.json({ limit: '9mb' }));
    mountConfigurationRoutes(app, store, workspaces, configuration, agents);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  async function shutdown() {
    if (!server) return;
    const current = server;
    server = undefined;
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }

  async function request<T>(route: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as T };
  }

  const configurationOf = (organizationId: string) =>
    request<ConfigurationView>(`/api/workspace/organizations/${organizationId}/configuration`);
  const compile = (organizationId: string) =>
    request<ConfigurationView & { code?: string }>(
      `/api/workspace/organizations/${organizationId}/configuration/compile`,
      'POST',
      {},
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

  const setupFile = (organizationId: string) =>
    path.join(store.dataDir, 'workspaces', 'setup', `${organizationId}.json`);

  /**
   * A finished setup with an active configuration, then rewritten as the
   * revision 1 build would have saved it: no first-run question, a fax number,
   * finished. Returns the organization and the record as saved.
   */
  async function finishedUnderOne(): Promise<{ organizationId: string; saved: BusinessSetup }> {
    const organizationId = (await workspaces.createOrganization({ name: 'Ridge Cabinetry' })).organizations[0]!
      .organization.id;
    await workspaces.startSetup(organizationId, 'start');
    let view = await workspaces.setupView(organizationId);
    for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1)
      view = await workspaces.answer(organizationId, { questionId: view.step, value: CANNED[view.step] ?? null });
    expect((await compile(organizationId)).status).toBe(200);
    const activated = await request<ConfigurationView>(
      `/api/workspace/organizations/${organizationId}/configuration/activate`,
      'POST',
      { revision: 1, expectedActiveRevision: null, activationId: 'revision-1-build' },
    );
    expect(activated.data.active?.revision).toBe(1);

    const current = JSON.parse(await fs.readFile(setupFile(organizationId), 'utf8')) as BusinessSetup;
    const { 'first-run': _new, ...answers } = current.answers;
    const name = current.answers.name!;
    const saved: BusinessSetup = {
      ...current,
      schemaRevision: 1,
      state: 'proposal-ready',
      cursor: 'review',
      answers: { ...answers, 'fax-number': given('fax-number', '555-0100', name.by, name.at) },
    };
    await fs.writeFile(setupFile(organizationId), JSON.stringify(saved, null, 2), 'utf8');
    await shutdown();
    await boot();
    return { organizationId, saved };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-incremental-setup-'));
    await boot();
  });

  afterEach(async () => {
    await shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('the active configuration stays active, and resuming asks only the changed and new questions', async () => {
    const { organizationId, saved } = await finishedUnderOne();
    const kept = Object.keys(saved.answers)
      .filter((id) => id !== 'spend-cap' && id !== 'fax-number')
      .sort();

    // Before anything is carried: the person reads what resuming does.
    const stale = await workspaces.setupView(organizationId);
    expect(stale).toMatchObject({ stale: true, unreadable: null, schemaRevision: 1, currentSchemaRevision: 2 });
    expect(stale.carry).toEqual({
      from: 1,
      to: 2,
      keeps: kept,
      asks: REVISION_2.changed,
      adds: REVISION_2.added,
      drops: REVISION_2.removed,
    });
    const row = workspaces.view().organizations.find((item) => item.organization.id === organizationId)!;
    expect(row.setup).toMatchObject({ questions: 'earlier', resumable: true });

    // Answers under the earlier questions are neither answered over nor compiled.
    await expect(workspaces.answer(organizationId, { questionId: 'spend-cap', value: 150 })).rejects.toMatchObject({
      status: 409,
      details: { code: 'stale_setup' },
    });
    expect(await compile(organizationId)).toMatchObject({ status: 409, data: { code: 'stale_setup' } });
    expect((await configurationOf(organizationId)).data.active?.revision).toBe(1);

    // Resuming carries every other answer across exactly, and asks the changed question first.
    const before = await fs.readFile(setupFile(organizationId));
    const resumed = await workspaces.startSetup(organizationId, 'resume');
    expect(resumed).toMatchObject({ stale: false, carry: null, schemaRevision: 2, state: 'drafting', step: 'spend-cap' });
    expect(Object.keys(resumed.answers).sort()).toEqual(kept);
    for (const id of kept) expect(resumed.answers[id]).toEqual(saved.answers[id]);

    // The file as the revision 1 build saved it is kept beside the carried one.
    const folder = path.dirname(setupFile(organizationId));
    const backups = (await fs.readdir(folder)).filter(
      (name) => name.startsWith(`${organizationId}.json.v1.`) && name.endsWith('.bak'),
    );
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(folder, backups[0]!))).toEqual(before);

    // Only the changed and the new question are asked, then the setup is finished again.
    let view: BusinessSetupView = await workspaces.answer(organizationId, { questionId: 'spend-cap', value: 150 });
    expect(view.step).toBe('first-run');
    view = await workspaces.answer(organizationId, { questionId: 'first-run', value: 'manual' });
    expect(view).toMatchObject({ state: 'proposal-ready', step: 'review' });

    // The new proposal changes the budget and inherits everything else, and
    // the revision 1 configuration stays active until the new one is activated.
    const staged = await compile(organizationId);
    expect(staged.status).toBe(200);
    expect(staged.data.staged?.revision).toBe(2);
    expect(staged.data.active?.revision).toBe(1);
    const moved = staged.data.changes.filter((change) => change.kind !== 'inherited');
    expect(moved.map((change) => [change.field, change.kind, change.was, change.now])).toEqual([
      ['budget', 'changed', '$100 per month', '$150 per month'],
    ]);
    const activated = await request<ConfigurationView>(
      `/api/workspace/organizations/${organizationId}/configuration/activate`,
      'POST',
      { revision: 2, expectedActiveRevision: 1, activationId: 'after-the-carry' },
    );
    expect(activated.data.active?.revision).toBe(2);
  });

  test('a carry that fails writes nothing, and the active configuration stays active', async () => {
    const { organizationId, saved } = await finishedUnderOne();
    // A record this build cannot carry: its answers are not a map.
    await fs.writeFile(setupFile(organizationId), JSON.stringify({ ...saved, answers: [] }, null, 2), 'utf8');
    await shutdown();
    await boot();
    const before = await fs.readFile(setupFile(organizationId));

    await expect(workspaces.startSetup(organizationId, 'resume')).rejects.toMatchObject({
      status: 409,
      details: { code: 'setup_unreadable' },
    });
    expect(await fs.readFile(setupFile(organizationId))).toEqual(before);
    const folder = path.dirname(setupFile(organizationId));
    expect((await fs.readdir(folder)).filter((name) => name.endsWith('.bak'))).toEqual([]);
    expect((await configurationOf(organizationId)).data.active?.revision).toBe(1);
  });
});

// --- a business the account service keeps (ORG-01) ----------------------------------

describe('a setup the account service keeps, saved by the revision 1 build (ORG-02 on ORG-01)', () => {
  interface Computer {
    app: Awaited<ReturnType<typeof createApp>>;
    server: Server;
    base: string;
  }

  let root: string;
  let cloud: FauxCloud;
  let backend: AccountBackend;
  let juniper: string;
  let computers: Computer[];

  async function computer(name: string): Promise<Computer> {
    const dir = path.join(root, name);
    const app = await createApp({
      dataDir: path.join(dir, 'data'),
      projectRoot: path.join(dir, 'projects'),
      engineService: new EngineService(path.join(dir, 'engines'), { discover: async () => [] }),
      reviewerAdapter: null,
      secretBox: testOnlySecretBox(),
      accounts: { backend },
    });
    const listening = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const opened = { app, server: listening, base: `http://127.0.0.1:${(listening.address() as AddressInfo).port}` };
    computers.push(opened);
    return opened;
  }

  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const request = (target: Computer, route: string, method = 'GET', body?: unknown) =>
    fetch(`${target.base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  async function api<T>(target: Computer, route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(target, route, method, body);
    const text = await response.text();
    expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
    return (text ? JSON.parse(text) : null) as T;
  }

  const signIn = async (target: Computer, email: string) =>
    (await api<AccountStateView>(target, '/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false }))
      .person!.id;

  const setupRoute = () => `/workspace/organizations/${juniper}/setup`;
  const summary = async (target: Computer) =>
    (await api<WorkspaceView>(target, '/workspace')).organizations.find((item) => item.organization.id === juniper)!;
  const rows = () => cloud.store.snapshot().organizationSetups.filter((row) => row.organizationId === juniper);

  /** Write a revision to the account service as this person, as a revision 1 build on their computer would. */
  async function writeAs(email: string, expectedRevision: number, setup: BusinessSetup) {
    const pair = await cloud.store.run((draft) =>
      cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }),
    );
    await cloud.accounts.signIn(pair.accessToken);
    const response = await cloud.handle(
      new Request(`http://faux.local/account/organizations/${juniper}/setup`, {
        method: 'POST',
        headers: { authorization: `Bearer ${pair.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision, record: { v: 1, setup } }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-incremental-setup-service-'));
    computers = [];
    cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
    juniper = (await seedDemo(cloud)).organizations!.juniper;
    backend = {
      client: new ControlPlaneClient('http://faux.local', async (req) => cloud.handle(req)),
      view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
      close: async () => {},
    };
  });

  afterEach(async () => {
    for (const target of computers) {
      await target.app.locals.close();
      target.server.closeAllConnections();
      await new Promise<void>((resolve) => target.server.close(() => resolve()));
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a Manager resumes the owner's setup: what it keeps stays the owner's, and the earlier revision keeps the rest", async () => {
    const laptop = await computer('laptop');
    const owner = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const tenantId = (await summary(laptop)).organization.tenantId;
    const at = '2026-09-20T10:00:00.000Z';
    const underOne: BusinessSetup = {
      v: 1,
      organizationId: juniper,
      tenantId,
      schemaRevision: 1,
      state: 'drafting',
      answers: {
        name: given('name', 'Juniper Street Bakery', owner, at),
        industry: given('industry', 'Bakery', owner, at),
        'spend-cap': given('spend-cap', 100, owner, at),
        'fax-number': given('fax-number', '555-0100', owner, at),
      },
      cursor: 'job',
      startedAt: at,
      startedBy: owner,
      updatedAt: at,
      proposalDigest: null,
    };
    await writeAs(DEMO_ACCOUNTS.owner.email, 0, underOne);

    const desktop = await computer('desktop');
    const manager = await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    expect((await summary(desktop)).setup).toMatchObject({ questions: 'earlier', resumable: true, source: 'service' });
    const stale = await api<BusinessSetupView>(desktop, setupRoute());
    expect(stale).toMatchObject({ stale: true, sync: { source: 'service', revision: 1 } });
    expect(stale.carry).toEqual({
      from: 1,
      to: 2,
      keeps: ['industry', 'name'],
      asks: REVISION_2.changed,
      adds: REVISION_2.added,
      drops: REVISION_2.removed,
    });

    // An Employee sees the setup's state and is asked nothing.
    const shop = await computer('shop');
    await signIn(shop, DEMO_ACCOUNTS.employee.email);
    expect((await summary(shop)).setup).toMatchObject({ questions: 'earlier', mayConfigure: false, resumable: false });

    const resumed = await api<BusinessSetupView>(desktop, `${setupRoute()}/resume`, 'POST', {});
    expect(resumed).toMatchObject({ schemaRevision: 2, state: 'drafting', step: 'job', sync: { revision: 2 } });

    // The service took the Manager's revision because the answers it carries are unchanged.
    const [first, second] = rows();
    expect(rows()).toHaveLength(2);
    expect(second).toMatchObject({ revision: 2, writtenBy: manager });
    expect(second!.record.setup.schemaRevision).toBe(2);
    expect(second!.record.setup.answers).toEqual({ name: underOne.answers.name, industry: underOne.answers.industry });
    expect(second!.record.setup.answers.name!.by).toBe(owner);
    // Nothing was deleted: the earlier revision still holds what was not carried.
    expect(Object.keys(first!.record.setup.answers).sort()).toEqual(['fax-number', 'industry', 'name', 'spend-cap']);
  });
});
