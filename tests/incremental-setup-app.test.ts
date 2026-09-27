/**
 * ORG-02 with the shipped questions, over HTTP, for a business the account
 * service keeps (ORG-01).
 *
 * Before ORG-02 a computer running an older build resumed a setup a newer
 * build had saved by replacing every answer with none, and saved that as the
 * business's next revision. Now it refuses and writes nothing. Two computers
 * resuming at once are held to the same compare-and-set as two answering at
 * once: one is saved, the other is told.
 *
 * `tests/incremental-setup-carry.test.ts` runs the carry itself, as a build
 * that ships revision 2 of the questions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { testOnlySecretBox } from '../server/connection-secrets';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import type { AccountStateView } from '../shared/accounts';
import { BUSINESS_SETUP_SCHEMA_REVISION, type BusinessSetup, type BusinessSetupView } from '../shared/business-setup';
import { SETUP_NEWER_REASON } from '../shared/setup-question-changes';
import type { WorkspaceView } from '../shared/workspaces';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

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
/** When set, every save to the account service waits on it first. */
let beforeSave: (() => Promise<void>) | null;

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

const request = (target: Computer, route: string, method = 'GET', body?: unknown) =>
  fetch(`${target.base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

async function api<T>(target: Computer, route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(target, route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

async function refused(target: Computer, route: string, method = 'GET', body?: unknown) {
  const response = await request(target, route, method, body);
  expect(response.ok, `${method} ${route} was expected to be refused`).toBe(false);
  return { status: response.status, body: (await response.json()) as { error?: string; code?: string } };
}

const signIn = async (target: Computer, email: string) =>
  (await api<AccountStateView>(target, '/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false }))
    .person!.id;

const setupRoute = () => `/workspace/organizations/${juniper}/setup`;
const openSetup = (target: Computer) => api<BusinessSetupView>(target, setupRoute());
const summary = async (target: Computer) =>
  (await api<WorkspaceView>(target, '/workspace')).organizations.find((item) => item.organization.id === juniper)!;
const rows = () => cloud.store.snapshot().organizationSetups.filter((row) => row.organizationId === juniper);

/** Write a revision to the account service as this person, as another build on their computer would. */
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-incremental-setup-app-'));
  computers = [];
  beforeSave = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  backend = {
    client: new ControlPlaneClient('http://faux.local', async (req) => {
      if (beforeSave && req.method === 'POST' && new URL(req.url).pathname.endsWith('/setup')) await beforeSave();
      return cloud.handle(req);
    }),
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

describe('a business setup across versions of the questions (ORG-02)', () => {
  test('a setup a newer version saved is refused on every route, and nothing is written over it', async () => {
    const laptop = await computer('laptop');
    const owner = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    let view = await api<BusinessSetupView>(laptop, `${setupRoute()}/start`, 'POST', {});
    view = await api<BusinessSetupView>(laptop, `${setupRoute()}/answer`, 'POST', {
      questionId: 'name',
      value: 'Juniper Street Bakery',
      unknown: false,
      expectedDigest: view.digest,
    });
    // The owner's phone runs a newer build that asks revision 2 of the questions.
    const newer = rows().at(-1)!.record.setup;
    const at = '2026-09-27T09:00:00.000Z';
    await writeAs(DEMO_ACCOUNTS.owner.email, 2, {
      ...newer,
      schemaRevision: BUSINESS_SETUP_SCHEMA_REVISION + 1,
      answers: {
        ...newer.answers,
        'busy-season': { questionId: 'busy-season', value: 'December', unknown: false, origin: 'person', at, by: owner, prompt: 'When are you busiest?' },
      },
      updatedAt: at,
    });
    expect(rows()).toHaveLength(3);

    const desktop = await computer('desktop');
    await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    expect((await summary(desktop)).setup).toMatchObject({ questions: 'newer', resumable: false, source: 'service' });
    const opened = await openSetup(desktop);
    expect(opened).toMatchObject({
      stale: false,
      carry: null,
      unreadable: { code: 'setup_newer', reason: SETUP_NEWER_REASON },
      answers: {},
      sync: { source: 'service', revision: 3 },
    });

    for (const action of ['resume', 'start', 'back']) {
      const refusal = await refused(desktop, `${setupRoute()}/${action}`, 'POST', {});
      expect(refusal, action).toMatchObject({ status: 409, body: { code: 'setup_newer' } });
    }
    expect(
      await refused(desktop, `${setupRoute()}/answer`, 'POST', { questionId: 'industry', value: 'Bakery', unknown: false }),
    ).toMatchObject({ status: 409, body: { code: 'setup_newer' } });
    expect(
      await refused(desktop, `/workspace/organizations/${juniper}/configuration/compile`, 'POST', {}),
    ).toMatchObject({ status: 409, body: { code: 'setup_newer' } });

    // The business's setup is still the one the newer build saved.
    expect(rows()).toHaveLength(3);
    expect(rows().at(-1)!.record.setup.answers['busy-season']?.value).toBe('December');
  });

  test('two computers resuming at once: one is saved, the other is told and shown what the business holds', async () => {
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    let view = await api<BusinessSetupView>(laptop, `${setupRoute()}/start`, 'POST', {});
    view = await api<BusinessSetupView>(laptop, `${setupRoute()}/answer`, 'POST', {
      questionId: 'name',
      value: 'Juniper Street Bakery',
      unknown: false,
      expectedDigest: view.digest,
    });
    const desktop = await computer('desktop');
    await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    expect((await openSetup(desktop)).sync?.revision).toBe(2);

    // Both read revision 2 before either saves.
    let arrived = 0;
    let bothArrived!: () => void;
    const both = new Promise<void>((resolve) => (bothArrived = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    beforeSave = async () => {
      arrived += 1;
      if (arrived === 2) bothArrived();
      await gate;
    };
    const fromLaptop = request(laptop, `${setupRoute()}/resume`, 'POST', {});
    const fromDesktop = request(desktop, `${setupRoute()}/resume`, 'POST', {});
    await both;
    release();
    const answers = await Promise.all([fromLaptop, fromDesktop]);
    beforeSave = null;

    const statuses = answers.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = answers.find((response) => response.status === 409)!;
    expect(((await loser.json()) as { code?: string }).code).toBe('setup_conflict');
    // One revision was added, not two, and neither computer lost the answer.
    expect(rows().map((row) => row.revision)).toEqual([1, 2, 3]);
    for (const target of [laptop, desktop]) {
      const now = await openSetup(target);
      expect(now).toMatchObject({ state: 'drafting', sync: { revision: 3 } });
      expect(now.answers.name?.value).toBe('Juniper Street Bakery');
    }
  });
});
