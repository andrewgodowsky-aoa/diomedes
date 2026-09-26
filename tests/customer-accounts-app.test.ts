/**
 * Customer accounts in the desktop host, over HTTP: sign-in required, kept
 * sign-ins, roles, and the first milestone of the access plan.
 *
 *   A Free person with a perfectly working AWS connection cannot start the
 *   Nectovia Agent. A Business member with the same connection can. Withdrawing
 *   the business's grant stops the next Agent message and deletes nothing.
 *
 * The account service is the real control-plane handler over the faux store
 * (services/control-plane/src/faux), in this process. Only the network under
 * the AI SDK is replaced, so nothing reaches AWS or spends money.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox, type SecretBox } from '../server/connection-secrets';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import type { AccountStateView } from '../shared/accounts';
import type { Conversation, Project } from '../shared/types';
import type { WorkspaceView } from '../shared/workspaces';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';

let root: string;
let cloud: FauxCloud;
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let sent: number;

const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  sent += 1;
  return sseResponse(
    responsesEvents({
      id: `resp_${sent}`,
      object: 'response',
      created_at: 1_760_000_000,
      model: AWS_LUNA_MODEL,
      status: 'completed',
      output: [{ type: 'message', id: `msg_${sent}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answered by the Agent.', annotations: [] }] }],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${sent}` },
  );
}) as typeof globalThis.fetch;

async function open(secretBox: SecretBox | null = testOnlySecretBox(), accounts: { backend: AccountBackend } | null = { backend }) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox,
    modelApiTransport: aws,
    accounts,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
}
const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
const signIn = (email: string, remember = false) =>
  api<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember });

/** A project and a thread on AWS, connected with an approved spend limit: a working provider. */
async function workingAws() {
  const project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  return { project, thread };
}
const say = (target: { project: Project; thread: Conversation }, commandId: string, text: string) =>
  request(`/projects/${target.project.id}/threads/${target.thread.id}/messages`, 'POST', {
    commandId,
    text,
    mode: 'auto',
    sources: [],
    consent: true,
  });

async function staffToken(email: string) {
  const pair = await cloud.store.run((draft) =>
    cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-accounts-'));
  sent = 0;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  await seedDemo(cloud);
  backend = {
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  await open();
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('customer accounts in the desktop host', () => {
  test('before anyone signs in, every route but the account routes answers sign_in_required', async () => {
    const settings = await request('/settings');
    expect(settings.status).toBe(401);
    expect(await settings.json()).toMatchObject({ code: 'sign_in_required' });
    const projects = await request('/projects', 'POST', { name: 'Nope' });
    expect(projects.status).toBe(401);
    const state = await api<AccountStateView>('/account');
    expect(state).toMatchObject({ signedIn: false, person: null, workspaces: [] });
    expect(state.backend).toMatchObject({ kind: 'faux', label: FAUX_BACKEND_LABEL, signIn: 'password' });
    const wrong = await request('/account/sign-in', 'POST', { email: 'owner@juniper.test', password: 'not-it', remember: false });
    expect(wrong.status).toBe(401);
    expect((await api<AccountStateView>('/account')).signedIn).toBe(false);
  });

  test('milestone: a Free person with a working connection cannot start the Agent; a Business member can; revoking stops the next message and deletes nothing', async () => {
    // Free: no business, so Personal, and the Agent refuses before anything is sent.
    const free = await signIn('free@example.test');
    expect(free.workspaces).toEqual([]);
    expect((await api<WorkspaceView>('/workspace')).active).toEqual({ kind: 'personal' });
    const target = await workingAws();
    const refused = await say(target, 'm-free', 'Summarize the linen order.');
    const refusedBody = await refused.text();
    expect(refused.status, refusedBody).toBe(403);
    expect(JSON.parse(refusedBody)).toMatchObject({ code: 'AGENT_NOT_INCLUDED' });
    expect(refusedBody).toMatch(/business/i);
    expect(sent).toBe(0);

    // The same connection, the same project, a Business Employee: the Agent answers.
    await api('/account/sign-out', 'POST');
    const employee = await signIn('employee@juniper.test');
    expect(employee.workspaces).toHaveLength(1);
    expect(employee.workspaces[0]).toMatchObject({ role: 'member', roleLabel: 'Employee' });
    expect(employee.workspaces[0].access).toMatchObject({ state: 'active', agent: { included: true }, grants: null });
    const workspace = await api<WorkspaceView>('/workspace');
    expect(workspace.active).toEqual({ kind: 'business', organizationId: employee.workspaces[0].organization.id });
    expect(workspace.organizations[0].entitlement).toMatchObject({ source: 'account-service', agent: true, state: 'active' });
    const answered = await say(target, 'm-business', 'Summarize the linen order.');
    const answeredBody = await answered.text();
    expect(answered.status, answeredBody).toBe(200);
    expect(JSON.parse(answeredBody)).toMatchObject({ answerText: 'Answered by the Agent.', outcome: { status: 'answered' } });
    expect(sent).toBeGreaterThan(0);

    // A billing staff member withdraws the business's grant in the account service.
    const billing = await staffToken('billing@diomedes.test');
    const organizationId = employee.workspaces[0].organization.id;
    const customer = await cloud.commercial.customer(billing, organizationId);
    const grant = customer.grants.find((item) => item.state === 'active')!;
    await cloud.commercial.revokeGrant(billing, organizationId, grant.id, { reason: 'Test: plan ended.' });

    const before = sent;
    const stopped = await say(target, 'm-after-revoke', 'Summarize it again.');
    const stoppedBody = await stopped.text();
    expect(stopped.status, stoppedBody).toBe(403);
    expect(JSON.parse(stoppedBody)).toMatchObject({ code: 'AGENT_NOT_INCLUDED' });
    expect(stoppedBody).toMatch(/Nectovia Agent|plan|include/i);
    expect(sent).toBe(before);
    // Nothing was deleted: the answered turn and the project are still there.
    const state = await api<{ conversations: { id: string; turns: { role: string; text?: string }[] }[] }>(`/projects/${target.project.id}/state`);
    const turns = state.conversations.find((item) => item.id === target.thread.id)!.turns;
    expect(turns.some((turn) => turn.role === 'assistant' && turn.text === 'Answered by the Agent.')).toBe(true);
    // The service recorded each decision with what it was pinned to.
    const after = await cloud.commercial.customer(billing, organizationId);
    expect(after.admissions.map((row) => row.decision)).toEqual(expect.arrayContaining(['admitted', 'refused']));
  });

  test('roles: an Owner sees the plan, a Manager invites Employees only, an Employee manages nobody', async () => {
    const owner = await signIn('owner@juniper.test');
    const org = owner.workspaces[0];
    expect(org).toMatchObject({ role: 'owner', roleLabel: 'Business owner', capabilities: { seePlan: true, managePeople: 'everyone' } });
    expect(org.access?.grants?.length).toBeGreaterThan(0);
    const roster = await api<{ people: { role: string }[]; invitations: unknown[] | null }>(`/account/organizations/${org.organization.id}/roster`);
    expect(roster.people.map((person) => person.role).sort()).toEqual(['admin', 'member', 'owner']);
    expect(roster.invitations).not.toBeNull();

    await api('/account/sign-out', 'POST');
    const manager = await signIn('manager@juniper.test');
    expect(manager.workspaces[0]).toMatchObject({ roleLabel: 'Manager', capabilities: { seePlan: false, managePeople: 'employees' } });
    expect(manager.workspaces[0].access?.grants).toBeNull();
    const code = await api<{ code: string; role: string }>(`/account/organizations/${org.organization.id}/invitation-codes`, 'POST', { role: 'member', days: 3 });
    expect(code).toMatchObject({ role: 'member' });
    const asAdmin = await request(`/account/organizations/${org.organization.id}/invitation-codes`, 'POST', { role: 'admin' });
    expect(asAdmin.status).toBe(403);

    await api('/account/sign-out', 'POST');
    const employee = await signIn('employee@juniper.test');
    expect(employee.workspaces[0].capabilities).toMatchObject({ managePeople: 'nobody', configure: false });
    const blocked = await request(`/account/organizations/${org.organization.id}/invitation-codes`, 'POST', { role: 'member' });
    expect(blocked.status).toBe(403);

    // A new person redeems the Manager's code and joins as an Employee.
    await api('/account/sign-out', 'POST');
    await api<AccountStateView>('/account/sign-up', 'POST', { name: 'Ada New', email: 'ada@juniper.test', password: 'long-enough-pass', remember: false });
    const joined = await api<{ role: string; account: AccountStateView }>('/account/invitation-codes/redeem', 'POST', { code: code.code });
    expect(joined.role).toBe('member');
    expect(joined.account.workspaces.map((item) => item.organization.name)).toEqual(['Juniper Street Bakery']);
    // People are managed in the account service, not by the local workspace routes.
    const local = await request(`/workspace/organizations/${org.organization.id}/invitations`, 'POST', { role: 'member' });
    expect(local.status).toBe(409);
    expect(await local.json()).toMatchObject({ code: 'managed_in_account' });
  });

  test('a business created while signed in is created in the account service, with no plan and no Agent', async () => {
    await signIn('free@example.test');
    const view = await api<WorkspaceView>('/workspace/organizations', 'POST', { name: 'Jordan Plumbing' });
    const created = view.organizations.find((item) => item.organization.name === 'Jordan Plumbing')!;
    expect(view.active).toEqual({ kind: 'business', organizationId: created.organization.id });
    expect(created.membership.role).toBe('owner');
    expect(created.entitlement).toMatchObject({ source: 'account-service', state: 'none', agent: false });
    const staff = await staffToken('support@diomedes.test');
    const found = await cloud.commercial.customers(staff, 'Jordan');
    expect(JSON.stringify(found)).toContain(created.organization.id);
  });

  test('"Keep me signed in" seals the sign-in with the OS box and resumes it after a restart', async () => {
    const box = testOnlySecretBox();
    await close();
    await open(box);
    const kept = await signIn('owner@juniper.test', true);
    expect(kept).toMatchObject({ signedIn: true, remember: true, protectedStorage: true });
    const file = await fs.readFile(path.join(root, 'data', 'accounts', 'remembered.json'), 'utf8');
    const saved = JSON.parse(file) as { accounts: { sealed: string }[] };
    const token = box.open(Buffer.from(saved.accounts[0].sealed, 'base64'));
    expect(token.length).toBeGreaterThan(20);
    expect(file).not.toContain(token);
    expect(file).not.toContain(FAUX_DEMO_PASSWORD);

    await close();
    await open(box);
    const resumed = await api<AccountStateView>('/account');
    expect(resumed).toMatchObject({ signedIn: true, person: { email: 'owner@juniper.test' } });
    expect((await request('/settings')).status).toBe(200);

    // Signing out keeps the account in the chooser, without a kept sign-in.
    const out = await api<AccountStateView>('/account/sign-out', 'POST');
    expect(out.signedIn).toBe(false);
    expect(out.remembered).toEqual([expect.objectContaining({ email: 'owner@juniper.test', canResume: false })]);
    const forgotten = await api<AccountStateView>('/account/forget', 'POST', { personId: out.remembered[0].personId });
    expect(forgotten.remembered).toEqual([]);
  });

  test('without protected storage nothing is kept: the chooser remembers the account and asks for the password', async () => {
    await close();
    await open(null);
    const state = await signIn('manager@juniper.test', true);
    expect(state).toMatchObject({ signedIn: true, remember: false, protectedStorage: false });
    const file = await fs.readFile(path.join(root, 'data', 'accounts', 'remembered.json'), 'utf8');
    expect(JSON.parse(file).accounts[0].sealed).toBeNull();
    await close();
    await open(null);
    const after = await api<AccountStateView>('/account');
    expect(after.signedIn).toBe(false);
    expect(after.remembered).toEqual([expect.objectContaining({ email: 'manager@juniper.test', canResume: false })]);
    const resume = await request('/account/resume', 'POST', { personId: after.remembered[0].personId });
    expect(resume.status).toBe(409);
    expect(await resume.json()).toMatchObject({ code: 'password_required' });
  });
});

describe('production entries turn accounts on', () => {
  test('the local service and the desktop app both pass the accounts option', async () => {
    const service = await fs.readFile(path.resolve('server/index.ts'), 'utf8');
    const desktop = await fs.readFile(path.resolve('desktop/main.mjs'), 'utf8');
    expect(service).toMatch(/createApp\(\{[^}]*accounts: \{\}/);
    // The desktop app also says whether it is the packaged build, and hands over its WorkOS sign-in.
    expect(desktop).toMatch(/accounts: \{ packaged: app\.isPackaged, identity: [^}]*\},/);
  });

  test('an embedded host without accounts says so, and its routes ask for no sign-in', async () => {
    await close();
    await open(null, null);
    expect(await api('/account')).toEqual({ v: 1, off: true });
    expect((await request('/settings')).status).toBe(200);
    expect((await request('/account/sign-in', 'POST', { email: 'owner@juniper.test', password: FAUX_DEMO_PASSWORD })).status).toBe(404);
  });
});
