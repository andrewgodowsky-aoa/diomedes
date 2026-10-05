/**
 * DIO-216 slice C: Nectovia tiers as roles under a lead that is not Nectovia. A local lead hands a
 * task to a Nectovia Focused worker and asks a Nectovia Thorough advisor. Each role is admitted on
 * the account's credits under its own job at its own tier, under the lead's root job, and the
 * account's escalation control decides which tiers may take the work. A local lead the person
 * starts with no team takes those two roles by default, where they can join, after it asks.
 *
 * The account service is the real control-plane handler over the faux store, in this process, and
 * its gateway answers with the default offline scripted provider. The escalation control read is
 * answered here, since the faux store keeps no such record. The local lead is a mocked host over a
 * copied descriptor and a scripted transport. Nothing reaches a provider or a real local model, and
 * nothing here starts one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import { NECTOVIA_SIGN_IN } from '../server/engines/nectovia.js';
import { EngineService } from '../server/engines/service.js';
import { loopEgressAuthorizer } from '../server/harness/capabilities/native-loop.js';
import type { HarnessHost } from '../server/harness/host.js';
import { jobKeyFor, type JobCaps } from '../server/job-caps.js';
import { NECTOVIA_LOOP_TEAM_REFUSED } from '../server/native-loop-routes.js';
import type { Store } from '../server/store.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { AccountStateView } from '../shared/accounts.js';
import { ESCALATION_HEADER, escalationAllows, type EscalationView } from '../shared/escalation-controls.js';
import {
  ADVISOR_NEEDS_WORKER,
  ESCALATION_UNREADABLE,
  NECTOVIA_ROLE_CREDITS,
  escalationConsentText,
  escalationRefusal,
  nectoviaRoleConsentText,
  nectoviaRoleLine,
  nectoviaTierName,
  type EscalationOffer,
  type EscalationRecord,
} from '../shared/escalation-roles.js';
import type { HarnessRun } from '../shared/harness.js';
import { LOCAL_MODEL_ACCOUNT } from '../shared/local-model.js';
import { NATIVE_LOOP_CAPABILITY, NATIVE_LOOP_DELEGATE_CAPABILITY, type LoopRunInput } from '../shared/native-loop.js';
import { ROUTING_TIERS } from '../shared/routing-policy.js';
import {
  TEAM_ADVISOR_CAPABILITY,
  TEAM_LIMITS,
  TEAM_WORKER_CAPABILITY,
  type TeamLeadView,
  type TeamRole,
} from '../shared/team-delegation.js';
import type { Project } from '../shared/types.js';
import { escalationOfferReasons, loopStartCommand, nectoviaRolesConsentText } from '../client/console/loop-start-model.js';
import { nectoviaRolesNote, roleLine } from '../client/console/lead-workers-model.js';
import { BONSAI_MODEL, FixedLocalModel } from './fixtures/local-model.js';
import { DELIVERY, LOCAL_BASE, LOCAL_GAMING, ORDER, SOURCES, localHost, teamFixture, type TeamFixture } from './fixtures/three-model-team.js';

// A run here ends in about a second alone, but in the full suite on a loaded machine it took more
// than 20 s once (the 0.2.3 build, 2026-10-05). settled() waits up to 60 s, so a test may take 90.
vi.setConfig({ testTimeout: 90_000 });

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const LEAD_ANSWER = 'Six napkins are short.';
/** What the account service answers when it sets no control: every tier may take escalated work. */
const ALLOWED: EscalationView = { enabled: true, tiers: [...ROUTING_TIERS], source: 'default', scopeRevision: 0, globalRevision: 0 };
const ESCALATION_READ = /^\/account\/routing\/(organization|individual)\/[^/]+\/escalation$/;
const TURNED_OFF = 'Handing work to Nectovia is turned off for this account.';
const THOROUGH_OFF = 'Handing work to Nectovia Thorough is turned off for this account.';
const NO_MANAGED_USAGE = 'This account does not include managed AI usage.';
/** The two Nectovia roles a person names beside a local lead, each by its tier. */
const TIERED = { worker: { route: 'nectovia', tier: 'focused' }, advisor: { route: 'nectovia', tier: 'thorough' } } as const;

interface GatewayCall { path: string; tier: string | null; escalation: string | null; job: string | null }
/** `error`: what the admission or the adapter refused with, when it did. */
interface Admission { route: string; requestId: string | null; tier: string | null; escalation: string | null; rootJobId: string | null; error?: string }
interface AdapterCall { route: string; runId: string; tier: string | null; escalation: string | null; error?: string }
const refusedWith = (row: { error?: string }) => (error: unknown): never => {
  row.error = error instanceof Error ? error.message : String(error);
  throw error;
};

let root: string | undefined;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let engines: EngineService;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base: string;
let fixture: TeamFixture;
/** What the account service answers for the escalation control; `unreadable` answers a body it can't parse. */
let control: EscalationView | 'unreadable';
let escalationReads: number;
let gateway: GatewayCall[];
let localCalls: { url: string; body: Record<string, unknown> | null }[];
let admissions: Admission[];
let adapters: AdapterCall[];
let commands = 0;
const store = (): Store => app!.locals.store;
const harness = (): HarnessHost => app!.locals.harness;

type ChatMessage = { role: string; tool_calls?: { function: { name: string } }[] };
const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
/**
 * The scripted local lead: a plan when it is offered no tools, then one task for its worker and one
 * question for its advisor, each only where that tool is offered and not used yet, then its answer.
 */
const localTransport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input);
  if (!target.startsWith(LOCAL_BASE)) throw new Error(`This fixture never reaches ${target}.`);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  localCalls.push({ url: target, body });
  if (target.endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
  if (target.endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
  if (target !== `${LOCAL_BASE}v1/chat/completions`) throw new Error(`The local fixture never answers ${target}.`);
  const offered = new Set(((body?.tools as { function: { name: string } }[] | undefined) ?? []).map((tool) => tool.function.name));
  const used = new Set(((body?.messages as ChatMessage[] | undefined) ?? [])
    .flatMap((message) => (message.tool_calls ?? []).map((call) => call.function.name)));
  const steps: [string, unknown][] = [
    ['assign_workers', { tasks: [{ task: 'Read delivery.md and say what is short.', files: ['delivery.md'] }] }],
    ['consult_advisor', { question: 'What should be checked before answering?' }],
  ];
  const next = steps.find(([name]) => offered.has(name) && !used.has(name));
  const id = `local-${localCalls.length}`;
  const answer = (content: string) =>
    Response.json({ id, model: BONSAI_MODEL, usage, choices: [{ finish_reason: 'stop', message: { content } }] });
  if (!offered.size) return answer('1. Hand delivery.md to the worker.\n2. Ask the advisor what to check.\n3. Answer.');
  if (!next) return answer(LEAD_ANSWER);
  return Response.json({ id, model: BONSAI_MODEL, usage, choices: [{ finish_reason: 'tool_calls', message: { content: null,
    tool_calls: [{ id: `call-${localCalls.length}`, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } }] });
}) as typeof globalThis.fetch;

async function staffToken(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}

/**
 * The app over the faux account service, signed in as nobody yet, or with no account service at all
 * (`accounts: false`), which is a computer nobody signed in on. Every model-API admission and every
 * loop adapter is recorded with the tier and role it named.
 */
async function open(options: { accounts?: boolean } = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio216-escalation-'));
  fixture = teamFixture();
  control = { ...ALLOWED, tiers: [...ALLOWED.tiers] };
  escalationReads = 0;
  gateway = [];
  localCalls = [];
  admissions = [];
  adapters = [];
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', async (req) => {
      const { pathname } = new URL(req.url);
      if (req.method === 'GET' && ESCALATION_READ.test(pathname)) {
        escalationReads += 1;
        return Response.json(control === 'unreadable' ? { enabled: true } : control);
      }
      if (pathname.startsWith('/managed/v1/'))
        gateway.push({ path: pathname, tier: req.headers.get('x-nectovia-tier'), escalation: req.headers.get(ESCALATION_HEADER),
          job: req.headers.get('x-nectovia-job') });
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
    modelApiTransport: localTransport,
    localModel: { host: localHost(fixture), source: new FixedLocalModel() },
    automationTickMs: null,
    ...(options.accounts === false ? {} : { accounts: { backend } }),
  });
  const admit = engines.admitModelApi.bind(engines);
  vi.spyOn(engines, 'admitModelApi').mockImplementation((route, input, agent, observe) => {
    const row: Admission = { route, requestId: input.requestId ?? null, tier: input.tier ?? null, escalation: input.escalation ?? null,
      rootJobId: agent?.rootJobId ?? null };
    admissions.push(row);
    return admit(route, input, agent, observe).catch(refusedWith(row));
  });
  const adapter = engines.loopAdapter.bind(engines);
  vi.spyOn(engines, 'loopAdapter').mockImplementation((route, request, stop) => {
    const row: AdapterCall = { route, runId: request.runId, tier: request.tier ?? null, escalation: request.escalation ?? null };
    adapters.push(row);
    return adapter(route, request, stop).catch(refusedWith(row));
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app!.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    const closing = server;
    server = undefined;
    try {
      await app!.locals.close();
    } finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  }
  app = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text, data: (text ? JSON.parse(text) : null) as T };
}
async function ok<T = any>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request<T>(route, method, body);
  expect(response.ok, `${method} ${route}: ${response.status} ${response.text}`).toBe(true);
  return response.data;
}
const signIn = (email: string) =>
  ok<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });

/** Harbor on the Service agreement template: the Agent, without included AI usage. */
async function serviceAgreement(organizationId: string) {
  const billing = await staffToken(DEMO_ACCOUNTS.staffBilling.email);
  const { grant } = await cloud.commercial.issueGrant(billing, organizationId, {
    planId: 'service-agreement',
    source: 'service-agreement',
    reference: 'Test agreement',
    note: 'The quoted implementation.',
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  expect(grant.features).toContain('nectovia-agent');
  expect(grant.features).not.toContain('managed-inference');
}

/** A project with the order and the delivery, owned by the business when one is named, shared with the local model and Nectovia. */
async function project(organizationId: string | null) {
  const projectId = (await ok<Project>('/projects', 'POST', { name: 'Linen orders' })).id;
  const folder = store().state(projectId).project.folder;
  await fs.writeFile(path.join(folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(folder, 'delivery.md'), DELIVERY);
  if (organizationId) await ok(`/workspace/organizations/${organizationId}/output`, 'POST', { projectId });
  const policy = await ok<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
  await ok(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version,
    routes: ['bonsai', 'nectovia'],
    documents: SOURCES,
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  return projectId;
}
const newTask = async (projectId: string) =>
  (await ok<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the linen delivery' })).id;

/** A loop on the local model's Gaming profile, as the person starts it. */
const localStart = (projectId: string, taskId: string, extra: Record<string, unknown> = {}) =>
  request<any>(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1,
    commandId: `dio216-escalation-${++commands}`,
    taskId,
    goal: 'Compare the delivery with the order and say what is short.',
    route: 'bonsai',
    model: LOCAL_GAMING,
    accountRoute: LOCAL_MODEL_ACCOUNT,
    consent: true,
    sources: SOURCES,
    ...extra,
  });

/** Every child run id a lead's recorded handoffs name, at any depth of their outputs. */
function childRunIds(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) childRunIds(item, found);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (key === 'childRunId' && typeof item === 'string') found.add(item);
      else childRunIds(item, found);
    }
  return found;
}
const stepsOf = (run: HarnessRun) => run.steps.map((step) => ({ id: step.intent.stepId, state: step.state, error: step.error }));

/**
 * How a run ended, said whole: its reason and failure, each step, what a stop or a handoff
 * recorded, each role's own run, and any admission or adapter that refused on the way.
 */
async function how(projectId: string, run: HarnessRun): Promise<string> {
  const handoffs = run.steps.filter((step) => /^(stop|team|workers|advise):/.test(step.intent.stepId));
  const children = await Promise.all([...childRunIds(handoffs.map((step) => step.output))].map(async (id) => {
    const child = await harness().get(projectId, id).catch(() => null);
    return child ? { id, state: child.state, cancelReason: child.cancelReason, failure: child.failure, steps: stepsOf(child) } : { id, missing: true };
  }));
  return JSON.stringify({
    state: run.state,
    cancelReason: run.cancelReason,
    failure: run.failure,
    steps: stepsOf(run),
    handoffs: handoffs.map((step) => ({ id: step.intent.stepId, output: step.output })),
    children,
    refusedAdmissions: admissions.filter((row) => row.error),
    refusedAdapters: adapters.filter((row) => row.error),
  });
}

/** Waits until the run ends, however it ends, and fails at once with how it ended unless it completed. */
async function settled(projectId: string, runId: string): Promise<HarnessRun> {
  const ended = await vi.waitFor(async () => {
    const run = await harness().get(projectId, runId);
    if (!['completed', 'failed', 'cancelled', 'reconcile_required'].includes(run.state)) throw new Error(`The run is still ${run.state}.`);
    return run;
  }, { timeout: 60_000 });
  expect(ended.state, await how(projectId, ended)).toBe('completed');
  await harness().bridge.flush();
  await cloud.idle();
  return harness().get(projectId, runId);
}
const inputOf = (run: HarnessRun) => run.input as unknown as LoopRunInput & { rootJobId?: string };
const nectoviaAdmissions = () => admissions.filter((row) => row.route === 'nectovia');
const roleCalls = () => gateway.filter((call) => call.path === '/managed/v1/responses');
const leads = (projectId: string) => ok<{ leads: { runId: string; route: string; team: TeamLeadView }[] }>(`/projects/${projectId}/loop/team`);

/** No Nectovia role was admitted or sent, nothing reached the local model, and no run exists. */
async function nothingSent(projectId: string) {
  expect(nectoviaAdmissions()).toEqual([]);
  expect(gateway).toEqual([]);
  expect(localCalls).toEqual([]);
  expect(fixture.acquires).toEqual([]);
  expect(await harness().list(projectId)).toEqual([]);
}

describe('a local lead with a Nectovia Focused worker and a Nectovia Thorough advisor', () => {
  test('admits each role under its own job at its own tier, under the lead’s root job, and every role call names its role', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    const projectId = await project(orgs.juniper);
    const started = await localStart(projectId, await newTask(projectId), { team: TIERED });
    expect(started.status, started.text).toBe(200);
    const runId = started.data.runId as string;
    const lead = await settled(projectId, runId);
    const rootJobId = jobKeyFor(projectId, runId);
    expect(inputOf(lead).rootJobId).toBe(rootJobId);
    // A team the person named is not a default, so nothing is recorded about defaults.
    expect(inputOf(lead).escalation).toBeUndefined();

    // The Team view: the local lead, and each role by its tier.
    const listed = await leads(projectId);
    expect(listed.leads.map((item) => [item.runId, item.route])).toEqual([[runId, 'bonsai']]);
    const team = listed.leads[0].team;
    expect(team.worker).toMatchObject({ route: 'nectovia', tier: 'focused' });
    expect(team.advisor).toMatchObject({ route: 'nectovia', tier: 'thorough' });
    expect(team).toMatchObject({ origin: null, escalation: null });
    expect(team.workers).toHaveLength(1);
    expect(team.workers[0]).toMatchObject({ outcome: 'completed', route: 'nectovia' });
    expect(team.advice).toHaveLength(1);
    expect(team.advice[0]).toMatchObject({ outcome: 'completed', route: 'nectovia' });
    const workerRun = team.workers[0].childRunId!;
    const advisorRun = team.advice[0].childRunId!;
    expect(roleLine(team.worker)).toBe(`${team.worker.agent.name} · Nectovia Focused`);
    expect(nectoviaRolesNote(team)).toEqual(['Nectovia Focused and Nectovia Thorough use your account’s credits.']);

    // Each role was admitted at the start under the lead's run and its own name, at its tier, under
    // the root job, and again under its own child run at the same tier when the lead handed it work.
    const nectovia = nectoviaAdmissions();
    expect(nectovia.find((row) => row.requestId === `${runId}-worker`)).toMatchObject({ tier: 'focused', escalation: 'worker', rootJobId });
    expect(nectovia.find((row) => row.requestId === `${runId}-advisor`)).toMatchObject({ tier: 'thorough', escalation: 'advisor', rootJobId });
    const byRun = (id: string) => nectovia.filter((row) => row.requestId === id);
    expect(byRun(workerRun).length).toBeGreaterThan(0);
    expect(byRun(advisorRun).length).toBeGreaterThan(0);
    for (const row of byRun(workerRun)) expect(row).toMatchObject({ tier: 'focused', escalation: 'worker' });
    for (const row of byRun(advisorRun)) expect(row).toMatchObject({ tier: 'thorough', escalation: 'advisor' });
    // Every Nectovia admission here was a role's; the lead's own admissions are local and name no tier.
    expect(nectovia.every((row) => row.tier !== null && row.escalation !== null)).toBe(true);
    const local = admissions.filter((row) => row.route === 'bonsai');
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((row) => row.tier === null && row.escalation === null)).toBe(true);

    // The managed adapter ran each role's child run at the role's tier.
    const adapted = [...new Set(adapters.filter((call) => call.route === 'nectovia')
      .map((call) => `${call.runId} ${call.tier} ${call.escalation}`))].sort();
    expect(adapted).toEqual([`${advisorRun} thorough advisor`, `${workerRun} focused worker`].sort());

    // The root job keeps its thread's tier. Each role's own jobs are pinned at the role's tier.
    const caps = engines.jobCaps as unknown as JobCaps;
    expect(caps.get(projectId, runId)?.tier).toBe(caps.tierFor(projectId, null));
    expect(caps.get(projectId, `${runId}-worker`)?.tier).toBe('focused');
    expect(caps.get(projectId, `${runId}-advisor`)?.tier).toBe('thorough');
    expect(caps.get(projectId, workerRun)?.tier).toBe('focused');
    expect(caps.get(projectId, advisorRun)?.tier).toBe('thorough');

    // Every managed call was a role's: it names the role and its tier, under the lead's root job.
    const calls = roleCalls();
    expect(calls.some((call) => call.escalation === 'worker')).toBe(true);
    expect(calls.some((call) => call.escalation === 'advisor')).toBe(true);
    for (const call of calls) {
      expect(call.escalation === 'worker' ? 'focused' : call.escalation === 'advisor' ? 'thorough' : null).toBe(call.tier);
      expect(call.job).toBe(rootJobId);
    }
    expect(fixture.acquires.every((options) => !options?.start)).toBe(true);
  });
});

describe('what a Nectovia role may send', () => {
  const ACCOUNT = 'nectovia:org_fixture';
  const NO_LONGER = 'The signed-in Nectovia account no longer matches this run.';
  const send = { destination: 'external', kind: 'model' };
  const run = (capabilityId: string) =>
    ({ capabilityId, projectId: 'p1', input: { route: 'nectovia', accountRoute: ACCOUNT } }) as unknown as HarnessRun;
  const SENDERS = [NATIVE_LOOP_CAPABILITY, TEAM_WORKER_CAPABILITY, TEAM_ADVISOR_CAPABILITY];

  test('a worker or an advisor sends as a Nectovia lead does, only while the account it was admitted under is signed in', async () => {
    let signedIn: string | null = ACCOUNT;
    const authorize = loopEgressAuthorizer(() => ({}), () => signedIn);
    for (const capabilityId of SENDERS)
      for (const phase of ['dispatch', 'result'] as const)
        await expect(authorize(run(capabilityId), send, phase)).resolves.toBeUndefined();
    signedIn = 'nectovia:org_other';
    for (const capabilityId of SENDERS) await expect(authorize(run(capabilityId), send, 'dispatch')).rejects.toThrow(NO_LONGER);
    signedIn = null;
    for (const capabilityId of SENDERS) await expect(authorize(run(capabilityId), send, 'result')).rejects.toThrow(NO_LONGER);
  });

  test('a delegate never sends to Nectovia, whoever is signed in', async () => {
    const authorize = loopEgressAuthorizer(() => ({}), () => ACCOUNT);
    await expect(authorize(run(NATIVE_LOOP_DELEGATE_CAPABILITY), send, 'dispatch'))
      .rejects.toThrow('Nectovia works only as a loop lead, a worker or an advisor.');
  });
});

describe('refused before any role is admitted or sent', () => {
  test('signed out: a Nectovia role asks the person to sign in', async () => {
    await open({ accounts: false });
    const projectId = await project(null);
    const refused = await localStart(projectId, await newTask(projectId), { team: TIERED });
    expect(refused.status).toBe(401);
    expect(refused.data).toMatchObject({ error: NECTOVIA_SIGN_IN, code: 'sign_in_required' });
    expect(admissions).toEqual([]);
    await nothingSent(projectId);
  });

  test('a business whose plan does not include the Agent', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const projectId = await project(orgs.harbor);
    const refused = await localStart(projectId, await newTask(projectId), { team: TIERED });
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({ code: 'AGENT_NOT_INCLUDED' });
    expect(admissions).toEqual([]);
    await nothingSent(projectId);
  });

  test('a business whose plan includes the Agent but not managed AI usage', async () => {
    await open();
    await serviceAgreement(orgs.harbor);
    await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const projectId = await project(orgs.harbor);
    const refused = await localStart(projectId, await newTask(projectId), { team: TIERED });
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({ error: NO_MANAGED_USAGE, code: 'AGENT_NOT_INCLUDED' });
    expect(admissions).toEqual([]);
    await nothingSent(projectId);
  });

  test('a Nectovia lead still takes no team, even one at a tier', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    const projectId = await project(orgs.juniper);
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId: 'dio216-nectovia-lead-team', taskId: await newTask(projectId),
      goal: 'Say what is short.', route: 'nectovia', consent: true, sources: [], team: { worker: TIERED.worker, advisor: null },
    });
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: NECTOVIA_LOOP_TEAM_REFUSED, code: 'loop_route_unsupported' });
    expect(admissions).toEqual([]);
    await nothingSent(projectId);
  });

  test('a tier names only a Nectovia role, a Nectovia role names its tier and never a model, and it asks first', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    const projectId = await project(orgs.juniper);
    const taskId = await newTask(projectId);
    const onLocal = await localStart(projectId, taskId, {
      team: { worker: { route: 'bonsai', model: LOCAL_GAMING, accountRoute: LOCAL_MODEL_ACCOUNT, tier: 'focused' }, advisor: null },
    });
    expect(onLocal.status).toBe(400);
    expect(onLocal.data).toMatchObject({ error: 'Only a Nectovia role names a tier.', code: 'team_role_invalid', role: 'worker' });
    const untiered = await localStart(projectId, taskId, { team: { worker: { route: 'nectovia' }, advisor: null } });
    expect(untiered.status).toBe(400);
    expect(untiered.data).toMatchObject({
      error: 'A Nectovia role names its tier: efficient, focused or thorough.', code: 'team_role_invalid', role: 'worker',
    });
    const named = await localStart(projectId, taskId, { team: { worker: { ...TIERED.worker, model: 'any-model' }, advisor: null } });
    expect(named.status).toBe(409);
    expect(named.data).toMatchObject({ error: 'The Nectovia model is managed. Send without choosing one.', code: 'route_refused', role: 'worker' });
    const unconfirmed = await localStart(projectId, taskId, { consent: false, team: TIERED });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.data).toMatchObject({ error: nectoviaRoleConsentText('worker', 'focused'), consentRequired: true, role: 'worker' });
    expect(admissions).toEqual([]);
    await nothingSent(projectId);
  });
});

describe('the account’s escalation control', () => {
  test('turned off: every tier is offered as unavailable in the gate’s words, and a role is refused', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    control = { enabled: false, tiers: [], source: 'scope', scopeRevision: 2, globalRevision: 0 };
    const projectId = await project(orgs.juniper);
    const offers = await ok<{ offers: EscalationOffer[]; credits: string }>(`/projects/${projectId}/loop/escalation`);
    expect(offers.offers).toEqual(ROUTING_TIERS.map((tier) => ({ tier, name: nectoviaTierName(tier), admitted: false, reason: TURNED_OFF })));
    expect(offers.credits).toBe(NECTOVIA_ROLE_CREDITS);
    const refused = await localStart(projectId, await newTask(projectId), { team: TIERED });
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: TURNED_OFF, code: 'escalation_refused', role: 'worker' });
    expect(escalationReads).toBeGreaterThan(0);
    await nothingSent(projectId);
  });

  test('a tier left out of the control is refused alone, and the tiers it lists still join', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    control = { enabled: true, tiers: ['efficient', 'focused'], source: 'scope', scopeRevision: 3, globalRevision: 0 };
    const projectId = await project(orgs.juniper);
    const offers = await ok<{ offers: EscalationOffer[] }>(`/projects/${projectId}/loop/escalation`);
    expect(offers.offers.map((offer) => [offer.tier, offer.admitted, offer.reason]))
      .toEqual([['efficient', true, null], ['focused', true, null], ['thorough', false, THOROUGH_OFF]]);
    const refused = await localStart(projectId, await newTask(projectId), { team: TIERED });
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: THOROUGH_OFF, code: 'escalation_refused', role: 'advisor' });
    expect(gateway).toEqual([]);
    expect(await harness().list(projectId)).toEqual([]);

    const started = await localStart(projectId, await newTask(projectId), { team: { worker: TIERED.worker, advisor: null } });
    expect(started.status, started.text).toBe(200);
    await settled(projectId, started.data.runId);
    const calls = roleCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatchObject({ tier: 'focused', escalation: 'worker' });
  });

  test('a control that can’t be read refuses every role, and nothing runs under the default', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    control = 'unreadable';
    const projectId = await project(orgs.juniper);
    const offers = await ok<{ offers: EscalationOffer[] }>(`/projects/${projectId}/loop/escalation`);
    expect(offers.offers.map((offer) => [offer.admitted, offer.reason])).toEqual(ROUTING_TIERS.map(() => [false, ESCALATION_UNREADABLE]));
    const refused = await localStart(projectId, await newTask(projectId), { team: TIERED });
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: ESCALATION_UNREADABLE, code: 'escalation_refused', role: 'worker' });
    await nothingSent(projectId);
  });

  test('a Nectovia lead’s own calls name no role, and it takes no default roles', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    const projectId = await project(orgs.juniper);
    const started = await request<{ runId: string }>(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId: 'dio216-nectovia-lead-calls', taskId: await newTask(projectId),
      goal: 'Read the order and report the count.', route: 'nectovia', consent: true, sources: [],
    });
    expect(started.status, started.text).toBe(200);
    const lead = await settled(projectId, started.data.runId);
    expect(inputOf(lead).escalation).toBeUndefined();
    expect(inputOf(lead).team ?? null).toBeNull();
    const calls = roleCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.escalation)).toEqual(calls.map(() => null));
    expect(nectoviaAdmissions().every((row) => row.tier === null && row.escalation === null)).toBe(true);
    expect(escalationReads).toBe(0);
  });
});

describe('the Nectovia roles a local lead takes by default', () => {
  test('join where allowed after the start asks, and the run and the Team view say which joined', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    const projectId = await project(orgs.juniper);
    const taskId = await newTask(projectId);
    const asked = await localStart(projectId, taskId);
    expect(asked.status).toBe(409);
    expect(asked.data).toMatchObject({
      error: escalationConsentText([{ role: 'worker', tier: 'focused' }, { role: 'advisor', tier: 'thorough' }]),
      consentRequired: true,
    });
    expect(asked.data.escalation).toEqual({ worker: 'focused', advisor: 'thorough' });
    // Reading what can join admits nothing, and nothing runs until the person confirms.
    expect(admissions).toEqual([]);
    expect(await harness().list(projectId)).toEqual([]);

    const started = await localStart(projectId, taskId, { escalation: true });
    expect(started.status, started.text).toBe(200);
    const runId = started.data.runId as string;
    const lead = await settled(projectId, runId);
    const record: EscalationRecord = {
      attached: [{ role: 'worker', tier: 'focused' }, { role: 'advisor', tier: 'thorough' }],
      leftOut: [],
    };
    expect(inputOf(lead).escalation).toEqual(record);
    expect((await ok<{ escalation: EscalationRecord | null }>(`/projects/${projectId}/loop/runs/${runId}`)).escalation).toEqual(record);
    const team = (await leads(projectId)).leads[0].team;
    expect(team).toMatchObject({ origin: 'escalation-default', escalation: record });
    expect(team.worker).toMatchObject({ route: 'nectovia', tier: 'focused' });
    expect(team.advisor).toMatchObject({ route: 'nectovia', tier: 'thorough' });
    // The team limits every lead's team has.
    expect(team.limits).toEqual({
      depth: TEAM_LIMITS.depth, concurrentWorkers: TEAM_LIMITS.concurrentWorkers,
      workersPerRun: TEAM_LIMITS.workersPerRun, advicePerRun: TEAM_LIMITS.advicePerRun,
    });
    expect(team.worker.budget).toEqual({ turns: TEAM_LIMITS.worker.turns, tokens: TEAM_LIMITS.worker.tokens, wallMs: TEAM_LIMITS.worker.wallMs });
    expect(nectoviaRolesNote(team)).toEqual([
      'Nectovia Focused joined as a worker by default.',
      'Nectovia Thorough joined as an advisor by default.',
      'Nectovia Focused and Nectovia Thorough use your account’s credits.',
    ]);
    const calls = roleCalls();
    expect(calls.some((call) => call.escalation === 'worker' && call.tier === 'focused')).toBe(true);
    expect(calls.some((call) => call.escalation === 'advisor' && call.tier === 'thorough')).toBe(true);
  });

  test('signed out: none join, nothing asks, and the lead runs on this computer alone', async () => {
    await open({ accounts: false });
    const projectId = await project(null);
    const started = await localStart(projectId, await newTask(projectId));
    expect(started.status, started.text).toBe(200);
    const lead = await settled(projectId, started.data.runId);
    expect(inputOf(lead).team ?? null).toBeNull();
    expect(inputOf(lead).escalation).toEqual({
      attached: [],
      leftOut: [
        { role: 'worker', tier: 'focused', reason: NECTOVIA_SIGN_IN },
        { role: 'advisor', tier: 'thorough', reason: ADVISOR_NEEDS_WORKER },
      ],
    });
    expect(nectoviaAdmissions()).toEqual([]);
    expect(gateway).toEqual([]);
  });

  test('without managed AI usage: none join, and the lead still runs', async () => {
    await open();
    await serviceAgreement(orgs.harbor);
    await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const projectId = await project(orgs.harbor);
    const started = await localStart(projectId, await newTask(projectId));
    expect(started.status, started.text).toBe(200);
    const lead = await settled(projectId, started.data.runId);
    expect(inputOf(lead).team ?? null).toBeNull();
    expect(inputOf(lead).escalation).toEqual({
      attached: [],
      leftOut: [
        { role: 'worker', tier: 'focused', reason: NO_MANAGED_USAGE },
        { role: 'advisor', tier: 'thorough', reason: ADVISOR_NEEDS_WORKER },
      ],
    });
    expect(nectoviaAdmissions()).toEqual([]);
    expect(gateway).toEqual([]);
  });

  test('a tier the control turns off is left out with the gate’s words, and the rest still ask first', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    control = { enabled: true, tiers: ['efficient', 'focused'], source: 'scope', scopeRevision: 4, globalRevision: 0 };
    const projectId = await project(orgs.juniper);
    const taskId = await newTask(projectId);
    const asked = await localStart(projectId, taskId);
    expect(asked.status).toBe(409);
    expect(asked.data).toMatchObject({ error: escalationConsentText([{ role: 'worker', tier: 'focused' }]), consentRequired: true });
    expect(asked.data.escalation).toEqual({ worker: 'focused' });
    const started = await localStart(projectId, taskId, { escalation: true });
    expect(started.status, started.text).toBe(200);
    const lead = await settled(projectId, started.data.runId);
    const record: EscalationRecord = {
      attached: [{ role: 'worker', tier: 'focused' }],
      leftOut: [{ role: 'advisor', tier: 'thorough', reason: THOROUGH_OFF }],
    };
    expect(inputOf(lead).escalation).toEqual(record);
    const team = (await leads(projectId)).leads[0].team;
    expect(team).toMatchObject({ origin: 'escalation-default', escalation: record, advisor: null });
    expect(team.worker).toMatchObject({ route: 'nectovia', tier: 'focused' });
    expect(nectoviaRolesNote(team)).toEqual([
      'Nectovia Focused joined as a worker by default.',
      `Nectovia Thorough was left out. ${THOROUGH_OFF}`,
      'Nectovia Focused uses your account’s credits.',
    ]);
  });

  test('with handing work to Nectovia turned off, none join and nothing asks', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    control = { enabled: false, tiers: [], source: 'global', scopeRevision: 0, globalRevision: 5 };
    const projectId = await project(orgs.juniper);
    const started = await localStart(projectId, await newTask(projectId));
    expect(started.status, started.text).toBe(200);
    const lead = await settled(projectId, started.data.runId);
    expect(inputOf(lead).escalation).toEqual({
      attached: [],
      leftOut: [
        { role: 'worker', tier: 'focused', reason: TURNED_OFF },
        { role: 'advisor', tier: 'thorough', reason: ADVISOR_NEEDS_WORKER },
      ],
    });
    expect(nectoviaAdmissions()).toEqual([]);
    expect(gateway).toEqual([]);
  });

  test('`escalation: false` and `team: null` start the lead alone without asking or reading the control', async () => {
    await open();
    await signIn(DEMO_ACCOUNTS.owner.email);
    const projectId = await project(orgs.juniper);
    for (const extra of [{ escalation: false }, { team: null }]) {
      const started = await localStart(projectId, await newTask(projectId), extra);
      expect(started.status, started.text).toBe(200);
      const lead = await settled(projectId, started.data.runId);
      expect(inputOf(lead).escalation).toBeUndefined();
      expect(inputOf(lead).team ?? null).toBeNull();
    }
    expect(escalationReads).toBe(0);
    expect(nectoviaAdmissions()).toEqual([]);
    expect(gateway).toEqual([]);
  });
});

describe('the words a Nectovia role is shown with', () => {
  /** Model, vendor and route names that never appear in role copy. */
  const NAMES = /\b(luna|kimi|k3|sol|gpt|claude|gemini|gemma|qwen|deepseek|bedrock|azure|aws|vertex|openai|anthropic|bonsai)\b/i;
  const role = (tier: TeamRole['tier']): TeamRole => ({
    agent: { id: 'diomedes.general', version: '1', name: 'General', ceiling: 'edit' },
    guidance: 'Does the task it is given.',
    artifact: 'answer.text',
    route: 'nectovia',
    model: 'managed-model-id',
    accountRoute: 'nectovia:org_fixture',
    ...(tier ? { tier } : {}),
    profile: null,
  });

  test('name a tier and its credits, never a model, a vendor or a route, with no dashes or emphasis', () => {
    const copy = [
      ...ROUTING_TIERS.map(nectoviaTierName),
      ...ROUTING_TIERS.flatMap((tier) => [
        nectoviaRoleLine('worker', tier), nectoviaRoleLine('advisor', tier),
        nectoviaRoleConsentText('worker', tier), nectoviaRoleConsentText('advisor', tier),
        escalationRefusal({ enabled: false, tiers: [] }, tier)!,
        escalationRefusal({ enabled: true, tiers: ROUTING_TIERS.filter((other) => other !== tier) }, tier)!,
        escalationRefusal(null, tier)!,
        nectoviaRolesConsentText('the lead', { worker: tier, advisor: tier }),
        roleLine(role(tier)),
      ]),
      escalationConsentText([{ role: 'worker', tier: 'focused' }, { role: 'advisor', tier: 'thorough' }]),
      escalationConsentText([{ role: 'worker', tier: 'focused' }]),
      NECTOVIA_ROLE_CREDITS,
      ESCALATION_UNREADABLE,
      ADVISOR_NEEDS_WORKER,
      ...nectoviaRolesNote({
        worker: { ...role('focused'), budget: { turns: 1, tokens: null, wallMs: null } },
        advisor: role('thorough'),
        origin: 'escalation-default',
        escalation: { attached: [{ role: 'worker', tier: 'focused' }], leftOut: [{ role: 'advisor', tier: 'thorough', reason: THOROUGH_OFF }] },
      }),
    ];
    expect(copy.length).toBeGreaterThan(20);
    for (const line of copy) {
      expect(line, line).not.toMatch(NAMES);
      expect(line, line).not.toContain('managed-model-id');
      expect(line, line).not.toMatch(/[–—*_]/);
    }
    // The gate's own sentence is the one the desktop shows.
    const gate = escalationAllows({ enabled: true, tiers: ['focused'] }, 'thorough');
    expect(escalationRefusal({ enabled: true, tiers: ['focused'] }, 'thorough')).toBe(gate.ok ? null : gate.reason);
    expect(escalationRefusal({ enabled: true, tiers: ['focused'] }, 'thorough')).toBe(THOROUGH_OFF);
    expect(roleLine(role('focused'))).toBe('General · Nectovia Focused');
  });

  test('the start dialog sends each role by its tier, never beside a Team, and says once what each tier refused', () => {
    const command = loopStartCommand({
      commandId: 'console-loop-1', taskId: 'task-1', goal: ' Count the napkins. ', route: 'azure-openai', sources: ['order.md'],
      consent: true, maxTurns: null, nectovia: { worker: 'focused', advisor: 'thorough' },
    });
    expect(command.team).toEqual({ scope: ['order.md'], worker: { route: 'nectovia', tier: 'focused' }, advisor: { route: 'nectovia', tier: 'thorough' } });
    expect(command.composition).toBeUndefined();
    expect(JSON.stringify(command.team)).not.toContain('model');
    const alone = loopStartCommand({
      commandId: 'console-loop-2', taskId: 'task-1', goal: 'Count.', route: 'azure-openai', sources: [],
      consent: true, maxTurns: null, nectovia: { worker: 'efficient', advisor: null },
    });
    expect(alone.team).toEqual({ scope: null, worker: { route: 'nectovia', tier: 'efficient' }, advisor: null });
    expect(() => loopStartCommand({
      commandId: 'console-loop-3', taskId: 'task-1', goal: 'Count.', route: 'azure-openai', sources: ['order.md'],
      consent: true, maxTurns: null, team: { scope: ['order.md'], worker: { profileId: 'helper-1' }, advisor: null },
      nectovia: { worker: 'focused', advisor: null },
    })).toThrow('Choose Nectovia roles or a Team, not both.');

    expect(nectoviaRolesConsentText('Azure OpenAI', { worker: 'focused', advisor: 'thorough' })).toBe(
      'Send the goal and the files it reads to Azure OpenAI. This loop hands tasks to Nectovia Focused with the files they need. ' +
      'This loop asks Nectovia Thorough for advice with the files it needs. They use your account’s credits.');
    expect(nectoviaRolesConsentText('Azure OpenAI', { worker: 'efficient', advisor: null })).toBe(
      'Send the goal and the files it reads to Azure OpenAI. This loop hands tasks to Nectovia Efficient with the files they need. ' +
      'It uses your account’s credits.');

    const offers: EscalationOffer[] = [
      { tier: 'efficient', name: 'Nectovia Efficient', admitted: true, reason: null },
      { tier: 'focused', name: 'Nectovia Focused', admitted: false, reason: TURNED_OFF },
      { tier: 'thorough', name: 'Nectovia Thorough', admitted: false, reason: TURNED_OFF },
    ];
    expect(escalationOfferReasons({ offers, credits: NECTOVIA_ROLE_CREDITS })).toEqual([TURNED_OFF]);
    expect(escalationOfferReasons(null)).toEqual([]);
  });
});
