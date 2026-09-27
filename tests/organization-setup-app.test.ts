/**
 * ORG-01 in the desktop host, over HTTP: a business's setup belongs to the
 * business, not to the computer that answered it.
 *
 * Each "computer" is its own desktop host with its own data folder. They share
 * one account service: the real control-plane handler over the faux store, in
 * this process. Only the account service's setup routes can be made
 * unreachable, so sign-in and membership keep answering while a setup cannot
 * be loaded.
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
import type { BusinessSetup, BusinessSetupView } from '../shared/business-setup';
import { SETUP_CACHED_REASON, SETUP_UNREACHABLE_REASON } from '../shared/organization-setup';
import type { WorkspaceView } from '../shared/workspaces';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const NAME_PROMPT = 'What should we call your business, and what work do you do?';

interface Computer {
  app: Awaited<ReturnType<typeof createApp>>;
  server: Server;
  base: string;
  dataDir: string;
}

let root: string;
let cloud: FauxCloud;
let backend: AccountBackend;
let juniper: string;
/** While false the account service's setup routes cannot be reached. Everything else still answers. */
let setupReachable: boolean;
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
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const opened: Computer = {
    app,
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dataDir: path.join(dir, 'data'),
  };
  computers.push(opened);
  return opened;
}

async function close(target: Computer) {
  await target.app.locals.close();
  target.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => target.server.close((error) => (error ? reject(error) : resolve())));
}

/** Quit the app on a computer. Its data folder stays, as it would. */
async function quit(target: Computer) {
  computers = computers.filter((item) => item !== target);
  await close(target);
}

const request = (target: Computer, route: string, method = 'GET', body?: unknown) =>
  fetch(`${target.base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

async function api<T>(target: Computer, route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(target, route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

/** A request that must be refused: its status and body. */
async function refused(target: Computer, route: string, method = 'GET', body?: unknown) {
  const response = await request(target, route, method, body);
  expect(response.ok, `${method} ${route} was expected to be refused`).toBe(false);
  return { status: response.status, body: (await response.json()) as { error?: string; code?: string } };
}

const signIn = async (target: Computer, email: string) => {
  const state = await api<AccountStateView>(target, '/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });
  return state.person!.id;
};

const setupRoute = () => `/workspace/organizations/${juniper}/setup`;
const openSetup = (target: Computer) => api<BusinessSetupView>(target, setupRoute());
const startSetup = (target: Computer) => api<BusinessSetupView>(target, `${setupRoute()}/start`, 'POST', {});
const answerWith = (target: Computer, view: BusinessSetupView, questionId: string, value: string) =>
  api<BusinessSetupView>(target, `${setupRoute()}/answer`, 'POST', { questionId, value, unknown: false, expectedDigest: view.digest });
const summary = async (target: Computer) =>
  (await api<WorkspaceView>(target, '/workspace')).organizations.find((item) => item.organization.id === juniper)!;

/** Every revision the account service keeps for Juniper Street Bakery, oldest first. */
const revisions = () =>
  cloud.store
    .snapshot()
    .organizationSetups.filter((row) => row.organizationId === juniper)
    .map((row) => ({ revision: row.revision, writtenBy: row.writtenBy, answers: Object.keys(row.record.setup.answers).sort() }));

/** Call the account service as a person, as their own device would. */
async function asPerson(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return (method: string, route: string, body?: unknown) =>
    cloud.handle(
      new Request(`http://faux.local${route}`, {
        method,
        headers: { authorization: `Bearer ${pair.accessToken}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-organization-setup-app-'));
  computers = [];
  setupReachable = true;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  backend = {
    client: new ControlPlaneClient('http://faux.local', async (req) => {
      if (!setupReachable && new URL(req.url).pathname.endsWith('/setup')) throw new TypeError('fetch failed');
      return cloud.handle(req);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
});

afterEach(async () => {
  for (const target of computers) await close(target);
  await fs.rm(root, { recursive: true, force: true });
});

describe('a business setup kept by the business (ORG-01)', () => {
  test('quitting and reopening the app does not ask the questions again', async () => {
    let laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    await answerWith(laptop, await startSetup(laptop), 'name', 'Juniper Street Bakery');
    await quit(laptop);
    laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    expect((await summary(laptop)).setup).toMatchObject({ state: 'drafting', answered: 1, resumable: true, source: 'service' });
    expect(await openSetup(laptop)).toMatchObject({ state: 'drafting', step: 'industry', sync: { source: 'service', revision: 2 } });
    expect(revisions()).toHaveLength(2);
  });

  test('a second computer resumes where the first left off, and the first is told rather than overwriting', async () => {
    const laptop = await computer('laptop');
    const owner = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    expect((await api<WorkspaceView>(laptop, '/workspace')).active).toEqual({ kind: 'business', organizationId: juniper });
    expect(await openSetup(laptop)).toMatchObject({ state: 'not-started', sync: { source: 'service', revision: 0, readOnly: false } });
    let view = await startSetup(laptop);
    expect(view).toMatchObject({ state: 'drafting', sync: { source: 'service', revision: 1 } });
    view = await answerWith(laptop, view, 'name', 'Juniper Street Bakery, wholesale bread and pastry');
    expect(view.sync?.revision).toBe(2);
    // The answer keeps the words of the question it was given against.
    expect(view.answers.name).toMatchObject({ by: owner, prompt: NAME_PROMPT });

    // Another computer, signed in as the Manager, finds the same business setup.
    const desktop = await computer('desktop');
    const manager = await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    expect((await summary(desktop)).setup).toMatchObject({ state: 'drafting', answered: 1, resumable: true, source: 'service' });
    const resumed = await openSetup(desktop);
    expect(resumed).toMatchObject({ state: 'drafting', step: 'industry', sync: { source: 'service', revision: 2 } });
    expect(resumed.answers.name).toMatchObject({ value: 'Juniper Street Bakery, wholesale bread and pastry', by: owner });
    await answerWith(desktop, resumed, 'industry', 'Bakery');

    // The laptop still holds revision 2. Its answer conflicts, and nothing is overwritten.
    const stale = await refused(laptop, `${setupRoute()}/answer`, 'POST', {
      questionId: 'industry',
      value: 'Food',
      unknown: false,
      expectedDigest: view.digest,
    });
    expect(stale).toMatchObject({ status: 409, body: { code: 'setup_conflict' } });
    const reloaded = await openSetup(laptop);
    expect(reloaded.answers.industry).toMatchObject({ value: 'Bakery', by: manager });
    expect(reloaded.sync?.revision).toBe(3);
    expect(revisions().map((row) => [row.revision, row.writtenBy])).toEqual([
      [1, owner],
      [2, owner],
      [3, manager],
    ]);
  });

  test('a setup that cannot be loaded is said to be, never shown as not started, and nothing is saved offline', async () => {
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const view = await answerWith(laptop, await startSetup(laptop), 'name', 'Juniper Street Bakery');

    setupReachable = false;
    // The laptop shows its own copy, read-only.
    const cached = await openSetup(laptop);
    expect(cached).toMatchObject({
      state: 'drafting',
      sync: { source: 'cache', revision: 2, readOnly: true, reason: SETUP_CACHED_REASON },
    });
    expect(cached.answers.name).toMatchObject({ value: 'Juniper Street Bakery' });
    expect(cached.digest).toBe(view.digest);
    const offline = await refused(laptop, `${setupRoute()}/answer`, 'POST', {
      questionId: 'industry',
      value: 'Bakery',
      unknown: false,
      expectedDigest: cached.digest,
    });
    expect(offline).toMatchObject({ status: 503, body: { code: 'setup_unavailable' } });
    expect(revisions()).toHaveLength(2);

    // A computer with no copy says it could not load, rather than asking the first question again.
    const desktop = await computer('desktop');
    await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    expect((await summary(desktop)).setup).toMatchObject({
      state: 'unavailable',
      source: 'unavailable',
      loadError: SETUP_UNREACHABLE_REASON,
      resumable: false,
    });
    expect(await refused(desktop, setupRoute())).toMatchObject({
      status: 503,
      body: { code: 'setup_unavailable', error: SETUP_UNREACHABLE_REASON },
    });
    expect(await refused(desktop, `${setupRoute()}/start`, 'POST', {})).toMatchObject({ status: 503, body: { code: 'setup_unavailable' } });
    expect(revisions()).toHaveLength(2);

    setupReachable = true;
    expect(await openSetup(desktop)).toMatchObject({ state: 'drafting', step: 'industry', sync: { source: 'service', revision: 2 } });
  });

  test("a person removed from the business gets the refusal, never this computer's copy, online or off", async () => {
    const secretish = 'Sourdough and rye, sold wholesale';
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    await answerWith(laptop, await startSetup(laptop), 'name', secretish);
    const desktop = await computer('desktop');
    const manager = await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    expect((await openSetup(desktop)).answers.name).toMatchObject({ value: secretish });

    // The owner removes the Manager in the account service. The desktop has not heard yet.
    const asOwner = await asPerson(DEMO_ACCOUNTS.owner.email);
    expect((await asOwner('PATCH', `/account/organizations/${juniper}/members/${manager}`, { role: 'admin', state: 'revoked' })).ok).toBe(true);
    const removed = await refused(desktop, setupRoute());
    expect(removed).toMatchObject({ status: 403, body: { code: 'not_a_member' } });
    expect(JSON.stringify(removed.body)).not.toContain(secretish);

    // Once the desktop has heard, its copy stays unusable even while the service can't be reached.
    await api(desktop, '/account/refresh', 'POST');
    expect((await api<WorkspaceView>(desktop, '/workspace')).revoked.map((item) => item.organizationId)).toContain(juniper);
    setupReachable = false;
    const offline = await refused(desktop, setupRoute());
    expect([403, 409]).toContain(offline.status);
    expect(JSON.stringify(offline.body)).not.toContain(secretish);
  });

  test('an owner transfer keeps every answer as given, and the new owner continues from it', async () => {
    const laptop = await computer('laptop');
    const owner = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    await answerWith(laptop, await startSetup(laptop), 'name', 'Juniper Street Bakery');
    const desktop = await computer('desktop');
    const manager = await signIn(desktop, DEMO_ACCOUNTS.manager.email);

    const asOwner = await asPerson(DEMO_ACCOUNTS.owner.email);
    const asManager = await asPerson(DEMO_ACCOUNTS.manager.email);
    expect((await asOwner('PATCH', `/account/organizations/${juniper}/members/${manager}`, { role: 'owner', state: 'active' })).ok).toBe(true);
    expect((await asManager('PATCH', `/account/organizations/${juniper}/members/${owner}`, { role: 'owner', state: 'revoked' })).ok).toBe(true);

    const continued = await openSetup(desktop);
    expect(continued.answers.name).toMatchObject({ by: owner });
    const next = await answerWith(desktop, continued, 'industry', 'Bakery');
    expect(next.answers.name).toMatchObject({ by: owner });
    expect(next.answers.industry).toMatchObject({ by: manager });
    expect(revisions()).toEqual([
      { revision: 1, writtenBy: owner, answers: [] },
      { revision: 2, writtenBy: owner, answers: ['name'] },
      { revision: 3, writtenBy: manager, answers: ['industry', 'name'] },
    ]);
    // The previous owner's laptop is refused, not shown its copy.
    expect(await refused(laptop, setupRoute())).toMatchObject({ status: 403, body: { code: 'not_a_member' } });
  });

  test('an Employee sees where setup stands but cannot open or change it', async () => {
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    await startSetup(laptop);
    const shop = await computer('shop');
    await signIn(shop, DEMO_ACCOUNTS.employee.email);
    expect((await summary(shop)).setup).toMatchObject({ state: 'drafting', mayConfigure: false, resumable: false, source: 'service' });
    expect(await refused(shop, setupRoute())).toMatchObject({ status: 403, body: { code: 'not_configurator' } });
    expect((await refused(shop, `${setupRoute()}/start`, 'POST', {})).status).toBe(403);
    expect(revisions()).toHaveLength(1);
  });

  test('a Manager invited later opens the setup where the owner left it, on their own computer', async () => {
    const laptop = await computer('laptop');
    const owner = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    await answerWith(laptop, await startSetup(laptop), 'name', 'Juniper Street Bakery');

    // Jordan is not a member yet, so their computer knows no such business.
    const home = await computer('home');
    const jordan = await signIn(home, DEMO_ACCOUNTS.free.email);
    expect(await refused(home, setupRoute())).toMatchObject({ status: 404, body: { code: 'unknown_organization' } });

    // The owner invites Jordan as a Manager, and Jordan accepts in the account service.
    const asOwner = await asPerson(DEMO_ACCOUNTS.owner.email);
    const { subject } = (await cloud.subjectFor(DEMO_ACCOUNTS.free.email))!;
    const invited = await asOwner('POST', `/account/organizations/${juniper}/invitations`, { subject, role: 'admin', ttlMs: 60_000 });
    expect(invited.status).toBe(201);
    const { token } = (await invited.json()) as { token: string };
    const asJordan = await asPerson(DEMO_ACCOUNTS.free.email);
    expect((await asJordan('POST', `/account/organizations/${juniper}/invitations/accept`, { token })).ok).toBe(true);

    // Once Jordan's computer has heard and Jordan switches to the business, the
    // intake continues rather than starting over.
    await api(home, '/account/refresh', 'POST');
    await api(home, '/workspace/switch', 'POST', { kind: 'business', organizationId: juniper });
    const opened = await openSetup(home);
    expect(opened.answers.name).toMatchObject({ value: 'Juniper Street Bakery', by: owner });
    const next = await answerWith(home, opened, 'industry', 'Bakery');
    expect(next.answers.industry).toMatchObject({ by: jordan });
    expect(revisions()).toEqual([
      { revision: 1, writtenBy: owner, answers: [] },
      { revision: 2, writtenBy: owner, answers: ['name'] },
      { revision: 3, writtenBy: jordan, answers: ['industry', 'name'] },
    ]);
  });

  test("a setup kept only on this computer before ORG-01 becomes the business's first revision when its author opens it", async () => {
    const laptop = await computer('laptop');
    const owner = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const { organization } = await summary(laptop);
    const at = '2026-09-20T10:00:00.000Z';
    const earlier: BusinessSetup = {
      v: 1,
      organizationId: juniper,
      tenantId: organization.tenantId,
      schemaRevision: 1,
      state: 'drafting',
      answers: { name: { questionId: 'name', value: 'Juniper Street Bakery', unknown: false, origin: 'person', at, by: owner } },
      cursor: 'industry',
      startedAt: at,
      startedBy: owner,
      updatedAt: at,
      proposalDigest: null,
    };
    const folder = path.join(laptop.dataDir, 'workspaces', 'setup');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `${juniper}.json`), JSON.stringify(earlier));

    expect(await openSetup(laptop)).toMatchObject({ state: 'drafting', stale: true, step: 'review', sync: { source: 'service', revision: 1 } });
    expect(revisions()).toEqual([{ revision: 1, writtenBy: owner, answers: ['name'] }]);
    expect(await api<BusinessSetupView>(laptop, `${setupRoute()}/resume`, 'POST', {})).toMatchObject({
      state: 'drafting', stale: false, schemaRevision: 2, step: 'industry',
      answers: { name: earlier.answers.name }, sync: { source: 'service', revision: 2 },
    });
    const desktop = await computer('desktop');
    await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    expect((await openSetup(desktop)).answers.name).toMatchObject({ value: 'Juniper Street Bakery', by: owner, at });
  });
});
