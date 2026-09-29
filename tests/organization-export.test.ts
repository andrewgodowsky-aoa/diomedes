/**
 * OPS-05 in the desktop host, over HTTP: the Business owner's export, written
 * into one of the business's own projects.
 *
 * The four acceptance cases the brief names:
 * - the export holds no bearer token (nor any other credential the desktop
 *   sent or was given);
 * - a former member cannot request one, even from a computer that still
 *   remembers the business;
 * - the manifest names what is left out, and why;
 * - revoking a person stops their future work, and the records the business
 *   keeps (their setup revisions, the history) are unchanged by it.
 *
 * Each "computer" is its own desktop host with its own data folder; they
 * share one account service, the real control-plane handler over the faux
 * store, in this process.
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
import { secretLikePaths } from '../server/organization-export';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import { organizationAccountExportSchema } from '../services/control-plane/src/organization-export/schema';
import type { AccountStateView } from '../shared/accounts';
import { containsSecretLikeText, type BusinessSetupView } from '../shared/business-setup';
import {
  EXIT_STEPS,
  EXPORT_FORMATS,
  OMITTED_CATEGORIES,
  type OrganizationExportManifest,
  type OrganizationExportResult,
} from '../shared/organization-export';
import type { Project } from '../shared/types';
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
/** Every bearer token, refresh token, invitation token and code the desktops sent or were given. */
let credentials: Set<string>;
/** How many times a desktop asked the account service for an export. */
let exportCalls: number;
let beforeExportAnswer: (() => Promise<void>) | null;

/** An invitation code as a person types it (INVITATION_CODE in the account service). */
const INVITATION_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

/** Tokens and invitation codes in an account service answer. */
function collect(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && (/^(accessToken|refreshToken|idToken|token)$/.test(key) || (key === 'code' && INVITATION_CODE.test(item))))
      credentials.add(item);
    else collect(item);
  }
}

async function computer(name: string, accounts = true): Promise<Computer> {
  const dir = path.join(root, name);
  const app = await createApp({
    dataDir: path.join(dir, 'data'),
    projectRoot: path.join(dir, 'projects'),
    engineService: new EngineService(path.join(dir, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    ...(accounts ? { accounts: { backend } } : {}),
  });
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const opened = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  computers.push(opened);
  return opened;
}

async function close(target: Computer) {
  await target.app.locals.close();
  target.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => target.server.close((error) => (error ? reject(error) : resolve())));
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
  (await api<AccountStateView>(target, '/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false })).person!.id;

/** A new project on this computer, linked to Juniper Street Bakery. */
async function businessProject(target: Computer, name: string): Promise<Project> {
  const project = await api<Project>(target, '/projects', 'POST', { name });
  await api(target, `/workspace/organizations/${juniper}/projects`, 'POST', { projectId: project.id });
  return project;
}

const exportRoute = () => `/workspace/organizations/${juniper}/export`;
const setupRoute = () => `/workspace/organizations/${juniper}/setup`;
const exportInto = (target: Computer, project: Project) =>
  api<OrganizationExportResult>(target, exportRoute(), 'POST', { projectId: project.id });

/** Every file an export wrote, by its name in the archive folder. */
async function archiveFiles(project: Project, folder: string): Promise<Map<string, string>> {
  const dir = path.join(project.folder, ...folder.split('/'));
  const names = await fs.readdir(dir);
  return new Map(await Promise.all(names.map(async (name) => [name, await fs.readFile(path.join(dir, name), 'utf8')] as const)));
}

async function exportsIn(project: Project): Promise<string[]> {
  return fs.readdir(path.join(project.folder, 'Exports')).catch(() => []);
}

/** Call the account service as a person, as their own device would. */
async function asPerson(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return (method: string, route: string, body?: unknown) =>
    cloud.handle(new Request(`http://faux.local${route}`, {
      method,
      headers: { authorization: `Bearer ${pair.accessToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-organization-export-'));
  computers = [];
  credentials = new Set();
  exportCalls = 0;
  beforeExportAnswer = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  backend = {
    client: new ControlPlaneClient('http://faux.local', async (req) => {
      const authorization = req.headers.get('authorization');
      if (authorization?.startsWith('Bearer ')) credentials.add(authorization.slice(7));
      if (new URL(req.url).pathname.endsWith('/export')) exportCalls += 1;
      const answer = await cloud.handle(req);
      if (new URL(req.url).pathname.endsWith('/export')) await beforeExportAnswer?.();
      const text = await answer.clone().text();
      try {
        collect(JSON.parse(text));
      } catch {
        // Not JSON: nothing to collect.
      }
      return answer;
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
});

afterEach(async () => {
  for (const target of computers) await close(target);
  await fs.rm(root, { recursive: true, force: true });
});

describe("the Business owner's export (OPS-05)", () => {
  test('switching to a Manager while the export is fetched refuses the write', async () => {
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const project = await businessProject(laptop, 'Bakery records');
    let arrived!: () => void;
    const fetched = new Promise<void>((resolve) => { arrived = resolve; });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    beforeExportAnswer = async () => { arrived(); await paused; };
    const pending = request(laptop, exportRoute(), 'POST', { projectId: project.id });
    await fetched;
    try {
      await api(laptop, '/account/sign-out', 'POST');
      await signIn(laptop, DEMO_ACCOUNTS.manager.email);
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'sign_in_required' });
    expect(await exportsIn(project)).toEqual([]);
  });

  test('writes every file into a project of the business, readable back, with no bearer token or other credential in it', async () => {
    const laptop = await computer('laptop');
    const owner = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const project = await businessProject(laptop, 'Bakery records');
    const started = await api<BusinessSetupView>(laptop, `${setupRoute()}/start`, 'POST', {});
    await api(laptop, `${setupRoute()}/answer`, 'POST', { questionId: 'name', value: 'Juniper Street Bakery', unknown: false, expectedDigest: started.digest });
    // An invitation code nobody has used yet: its code is a credential.
    const asOwner = await asPerson(DEMO_ACCOUNTS.owner.email);
    const code = (await (await asOwner('POST', `/account/organizations/${juniper}/invitation-codes`, { role: 'member', email: null, ttlMs: 3_600_000 })).json()) as { id: string; code: string };
    credentials.add(code.code);

    const result = await exportInto(laptop, project);
    expect(result).toMatchObject({ projectId: project.id, folder: expect.stringMatching(/^Exports\/business-records-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/) });
    const files = await archiveFiles(project, result.folder);
    const manifest = JSON.parse(files.get('manifest.json')!) as OrganizationExportManifest;
    expect(manifest).toEqual({ format: EXPORT_FORMATS.manifest, ...result.manifest });
    expect([...files.keys()].sort()).toEqual([...manifest.files.map((file) => file.path), 'manifest.json', 'README.md'].sort());
    expect(manifest.exportedBy).toEqual({ personId: owner, name: DEMO_ACCOUNTS.owner.name });

    // No bearer token, refresh token, invitation token or code, in any file.
    expect(credentials.size).toBeGreaterThan(2);
    for (const [name, text] of files)
      for (const credential of credentials) expect(text.includes(credential), `${name} holds a credential`).toBe(false);
    // Nor anything that looks like one, field by field.
    for (const [name, text] of files)
      expect(name.endsWith('.json') ? secretLikePaths(JSON.parse(text)) : containsSecretLikeText(text) ? [name] : []).toEqual([]);

    // The manifest names what is left out, and why, and how leaving works.
    expect(manifest.omitted).toEqual(OMITTED_CATEGORIES);
    expect(manifest.leaving).toEqual(EXIT_STEPS);
    expect(files.get('README.md')).toContain('Taking it changed nothing');

    // The account service's records read back exactly, through the strict schema.
    const business = JSON.parse(files.get('business.json')!);
    const revisions = JSON.parse(files.get('setup-revisions.json')!);
    const history = JSON.parse(files.get('account-history.json')!);
    const readBack = organizationAccountExportSchema.parse({
      v: 1, organization: business.organization, exportedAt: business.exportedAt, exportedBy: business.exportedBy,
      people: business.people, invitations: business.invitations, access: business.plan, devices: business.phones,
      setupRevisions: revisions.revisions, history: { events: history.events, complete: history.complete },
    });
    const kept = cloud.store.snapshot().organizationSetups.filter((row) => row.organizationId === juniper);
    expect(readBack.setupRevisions).toEqual(kept.map((row) => ({ revision: row.revision, writtenAt: row.writtenAt, writtenBy: row.writtenBy, record: row.record })));
    expect(readBack.invitations.map((item) => item.id)).toEqual([code.id]);
    expect(JSON.parse(files.get('this-computer.json')!).projects).toEqual([{ projectId: project.id, name: 'Bakery records', folder: project.folder }]);

    // One recorded write in the project's History.
    const days = (await api<{ days: { entries: { id: string; sentence: string; files: { path: string; op: string }[] }[] }[] }>(laptop, `/projects/${project.id}/history`)).days;
    const entry = days.flatMap((day) => day.entries).find((item) => item.id === result.historyEntryId)!;
    expect(entry.sentence).toBe(`You exported Juniper Street Bakery's records to ${result.folder}.`);
    expect(entry.files).toHaveLength(files.size);
    expect(new Set(entry.files.map((file) => file.op))).toEqual(new Set(['created']));
  });

  test('exporting again writes a new folder and never touches the first', async () => {
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const project = await businessProject(laptop, 'Bakery records');
    const first = await exportInto(laptop, project);
    const before = await archiveFiles(project, first.folder);
    const second = await exportInto(laptop, project);
    expect(second.folder).not.toBe(first.folder);
    expect(await archiveFiles(project, first.folder)).toEqual(before);
    expect((await exportsIn(project)).sort()).toEqual([first.folder, second.folder].map((folder) => folder.slice('Exports/'.length)).sort());
  });

  test('a Manager is refused by the account service and nothing is written', async () => {
    const desktop = await computer('desktop');
    await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    const project = await businessProject(desktop, 'Front office');
    expect(await refused(desktop, exportRoute(), 'POST', { projectId: project.id })).toMatchObject({
      status: 403, body: { code: 'role_not_allowed', error: "Only the Business owner can export the business's records." },
    });
    expect(await exportsIn(project)).toEqual([]);
  });

  test("a project outside the business is refused before the account service is asked", async () => {
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const loose = await api<Project>(laptop, '/projects', 'POST', { name: 'Personal notes' });
    expect(await refused(laptop, exportRoute(), 'POST', { projectId: loose.id })).toMatchObject({ status: 409, body: { code: 'export_project_not_owned' } });
    expect(await refused(laptop, exportRoute(), 'POST', {})).toMatchObject({ status: 409, body: { code: 'export_project_not_owned' } });
    expect(exportCalls).toBe(0);
    expect(await exportsIn(loose)).toEqual([]);
  });

  test('a former owner cannot request an export, even from a computer that still remembers the business', async () => {
    const laptop = await computer('laptop');
    const previous = await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const project = await businessProject(laptop, 'Bakery records');
    // Ownership moves to the Manager, who then removes the previous owner.
    const asOwner = await asPerson(DEMO_ACCOUNTS.owner.email);
    const asManager = await asPerson(DEMO_ACCOUNTS.manager.email);
    const manager = cloud.store.snapshot().accounts.persons.find((person) => person.name === DEMO_ACCOUNTS.manager.name)!.id;
    expect((await asOwner('PATCH', `/account/organizations/${juniper}/members/${manager}`, { role: 'owner', state: 'active' })).ok).toBe(true);
    expect((await asManager('PATCH', `/account/organizations/${juniper}/members/${previous}`, { role: 'owner', state: 'revoked' })).ok).toBe(true);

    // The laptop has not heard: it still lists the business as the previous owner's. The account service refuses.
    expect(await refused(laptop, exportRoute(), 'POST', { projectId: project.id })).toMatchObject({ status: 403, body: { code: 'not_a_member' } });
    expect(await exportsIn(project)).toEqual([]);
    // Once it has heard, the business is not theirs here either.
    await api(laptop, '/account/refresh', 'POST');
    expect((await api<WorkspaceView>(laptop, '/workspace')).revoked.map((item) => item.organizationId)).toContain(juniper);
    expect(await refused(laptop, exportRoute(), 'POST', { projectId: project.id })).toMatchObject({ status: 404, body: { code: 'organization_not_found' } });
    expect(await exportsIn(project)).toEqual([]);
  });

  test('revoking a person stops their future work, and the records the business keeps are unchanged by it', async () => {
    const laptop = await computer('laptop');
    await signIn(laptop, DEMO_ACCOUNTS.owner.email);
    const project = await businessProject(laptop, 'Bakery records');
    const started = await api<BusinessSetupView>(laptop, `${setupRoute()}/start`, 'POST', {});
    await api(laptop, `${setupRoute()}/answer`, 'POST', { questionId: 'name', value: 'Juniper Street Bakery', unknown: false, expectedDigest: started.digest });
    // The Manager answers from their own computer: a revision in their name.
    const desktop = await computer('desktop');
    const manager = await signIn(desktop, DEMO_ACCOUNTS.manager.email);
    const opened = await api<BusinessSetupView>(desktop, setupRoute());
    await api(desktop, `${setupRoute()}/answer`, 'POST', { questionId: 'industry', value: 'Bakery', unknown: false, expectedDigest: opened.digest });

    const first = await exportInto(laptop, project);
    const firstRevisions = (await archiveFiles(project, first.folder)).get('setup-revisions.json')!;
    expect(JSON.parse(firstRevisions).revisions.map((row: { writtenBy: string }) => row.writtenBy)).toContain(manager);
    const kept = JSON.stringify(cloud.store.snapshot().organizationSetups);

    // The owner removes the Manager.
    const asOwner = await asPerson(DEMO_ACCOUNTS.owner.email);
    expect((await asOwner('PATCH', `/account/organizations/${juniper}/members/${manager}`, { role: 'admin', state: 'revoked' })).ok).toBe(true);

    // Their future work stops: the business's setup can be neither read nor changed from their computer.
    const reopened = await refused(desktop, setupRoute());
    expect(reopened).toMatchObject({ status: 403, body: { code: 'not_a_member' } });
    expect(JSON.stringify(reopened.body)).not.toContain('Juniper Street Bakery');
    expect((await refused(desktop, `${setupRoute()}/answer`, 'POST', { questionId: 'industry', value: 'Cafe', unknown: false, expectedDigest: opened.digest })).status).toBe(403);

    // What the business keeps is unchanged: every revision, including the Manager's, as it was.
    expect(JSON.stringify(cloud.store.snapshot().organizationSetups)).toBe(kept);
    const second = await exportInto(laptop, project);
    const files = await archiveFiles(project, second.folder);
    expect(JSON.parse(files.get('setup-revisions.json')!).revisions).toEqual(JSON.parse(firstRevisions).revisions);
    const business = JSON.parse(files.get('business.json')!);
    expect(business.people.find((person: { personId: string }) => person.personId === manager)).toMatchObject({ state: 'revoked' });
    const history = JSON.parse(files.get('account-history.json')!);
    expect(history.events.at(-1)).toMatchObject({ kind: 'membership-changed', targetId: manager });
  });

  test('a business kept only on this computer has no account records to export', async () => {
    const local = await computer('offline', false);
    const created = await api<WorkspaceView>(local, '/workspace/organizations', 'POST', { name: 'Corner Shop', industry: null });
    const organization = (created.active as { kind: 'business'; organizationId: string }).organizationId;
    const project = await api<Project>(local, '/projects', 'POST', { name: 'Shop' });
    await api(local, `/workspace/organizations/${organization}/projects`, 'POST', { projectId: project.id });
    expect(await refused(local, `/workspace/organizations/${organization}/export`, 'POST', { projectId: project.id })).toMatchObject({
      status: 409, body: { code: 'export_needs_account' },
    });
    expect(await exportsIn(project)).toEqual([]);
  });
});
