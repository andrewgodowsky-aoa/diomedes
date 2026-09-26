/**
 * Every entry point that runs Nectovia Agent work, or spends Diomedes-funded money, against the
 * two businesses the faux seed holds (task 5):
 *
 *   entry point                                    what admits it
 *   Home conversation (nectovia, managed)          Agent gate, managed: 'nectovia-agent' + 'managed-inference'
 *   Project conversation (own AWS connection)      Agent gate: 'nectovia-agent'
 *   Build from a thread (own AWS connection)       Agent gate, on the Work call
 *   Work loop start (own AWS connection)           Agent gate, through the harness's loop seam
 *   Work loop drive, resume and delegates          Agent gate, on each drive's adapter and each child
 *   A team member's Work turn                      Agent gate, before the member's run starts
 *   Jev preflight on the owner's own route         Agent gate, before the advisor is asked
 *   A managed call at the account service          its gateway, on every call: both features again
 *
 * Harbor Hardware holds no grant: it is refused at every one before anything is sent. Juniper
 * Street Bakery holds Business: it is admitted at every one. A business on a service agreement
 * holds the Agent without included AI usage: it is refused Diomedes-funded work before the service
 * records anything, the gateway refuses a managed call it makes anyway, and its own connection
 * still runs. A managed preflight is admitted by the managed advisor itself, pinned to its own
 * job, and checked again at the gateway (tests/jev-managed-evaluations.test.ts).
 *
 * Not in this matrix, each gated in its own lane: owner rules and trigger rules reaching the work
 * ('owner-rules', feature/paid-business-rules) and the phone relay ('phone-relay',
 * feature/phone-relay).
 *
 * The account service is the real control-plane handler over the faux store, in this process,
 * managed gateway included. AWS, the gateway's provider and the Jev port are scripted doubles
 * that count every call. Nothing leaves this process.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { MANAGED_USAGE_NOT_INCLUDED } from '../server/accounts/agent-gate';
import type { AccountBackend } from '../server/accounts/backend';
import { ControlPlaneClient } from '../server/accounts/client';
import { testOnlySecretBox } from '../server/connection-secrets';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { EngineService } from '../server/engines/service';
import { scriptedEvaluationPort, type ScriptedEvaluationPort } from '../server/harness/evaluation-adapter';
import { createJevAdvisor } from '../server/harness/jev-advisor';
import { teamToolRegistry } from '../server/team/tools';
import type { TierPolicy } from '../services/control-plane/src/commercial';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import { MANAGED_USAGE_NOT_INCLUDED as GATEWAY_USAGE_NOT_INCLUDED } from '../services/control-plane/src/managed-inference';
import { AGENT_NOT_INCLUDED_REASON } from '../shared/access';
import type { AccountStateView } from '../shared/accounts';
import type { Conversation, Project } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const ANSWER = 'Answered by the Agent.';
const PLAN = 'Work out a staffing plan for the holiday weekend given the new opening hours.';

let root: string;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let policy: TierPolicy;
let engines: EngineService;
let port: ScriptedEvaluationPort;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
/**
 * Calls that left: AWS on the business's own connection, this computer's calls to the account
 * service's managed gateway, and the gateway's calls to the company's provider.
 */
let calls: { aws: number; gateway: number; provider: number };

const answer = (id: string, model: string) =>
  sseResponse(
    responsesEvents({
      id,
      object: 'response',
      created_at: 1_790_000_000,
      model,
      status: 'completed',
      output: [{ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: ANSWER, annotations: [] }] }],
      usage: { input_tokens: 90, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 98 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${id}` },
  );

const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
/** A signed-in session at the account service, for staff or a customer. */
async function tokenFor(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}
/** Every Agent admission the service recorded for a business, oldest first. */
async function admissions(organizationId: string) {
  return (await cloud.commercial.customer(await tokenFor(DEMO_ACCOUNTS.staffBilling.email), organizationId)).admissions as {
    decision: string;
    surface: string;
    routeKind: string;
  }[];
}
const signIn = (email: string) => api<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-paid-abilities-'));
  calls = { aws: 0, gateway: 0, provider: 0 };
  cloud = await createFauxCloud({
    file: null,
    passwordIterations: 1_000,
    // The gateway's provider: what would reach Bedrock on the company's account.
    managed: {
      transport: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.provider += 1;
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model?: unknown };
        return answer(`gw_${calls.provider}`, String(body.model));
      }) as typeof globalThis.fetch,
    },
  });
  orgs = (await seedDemo(cloud)).organizations!;
  // The Routing role qualifies GPT-6 Luna and publishes it for Efficient and Focused, as in
  // nectovia-bot-app.test.ts, so a Home message has a model to run on.
  const routing = await tokenFor(DEMO_ACCOUNTS.staffRouting.email);
  const luna = (await cloud.commercial.routes(routing)).routes.find((row) => row.id === 'aws-luna-6')!;
  await cloud.commercial.saveRoute(routing, {
    id: 'aws-luna-6',
    provider: 'aws-bedrock',
    model: 'us.openai.gpt-6-luna',
    label: 'GPT-6 Luna',
    region: 'us',
    processing: 'AWS Bedrock US inference profile.',
    status: 'qualified',
    evidence: 'Test fixture: qualified for this file.',
    baseRevision: luna.revision,
  });
  policy = await cloud.commercial.publishPolicy(routing, {
    tiers: { efficient: 'aws-luna-6', focused: 'aws-luna-6', thorough: null },
    note: 'Test fixture: GPT-6 Luna for Efficient and Focused.',
    baseRevision: 1,
  });
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (req) => {
      if (new URL(req.url).pathname.startsWith('/managed/v1/')) calls.gateway += 1;
      return cloud.handle(req);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  port = scriptedEvaluationPort({
    result: {
      answers: {
        workload: { type: 'choice', choice: 'planning', probabilities: { lookup: 0.05, extraction: 0.05, planning: 0.8, reasoning: 0.1 } },
        'needs-unattached-material': { type: 'boolean', probability: 0.1 },
        'needs-clarification': { type: 'boolean', probability: 0.1 },
        'needs-extra-review': { type: 'boolean', probability: 0.9 },
      },
    },
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: (async () => {
      calls.aws += 1;
      return answer(`aws_${calls.aws}`, AWS_LUNA_MODEL);
    }) as typeof globalThis.fetch,
    jevAdvisor: createJevAdvisor({ port }),
    accounts: { backend },
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  // Settlements the gateway started finish before the store goes.
  await cloud.idle();
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The business's own AWS connection, with an approved spend limit: a working provider. */
async function connectAws() {
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  const view = await api<{ connection: { accountRoute: string } }>('/ai/model-api/aws-bedrock');
  return view.connection.accountRoute;
}
/** A project of the signed-in person's business, with a thread on AWS and a task. */
async function workOnAws(name: string, accountRoute: string) {
  const project = await api<Project>('/projects', 'POST', { name });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  const taskId = (await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: 'Check the order' })).id;
  return { projectId: project.id, threadId: thread.id, taskId, accountRoute };
}
type Work = Awaited<ReturnType<typeof workOnAws>>;

/** The entry points, each as the person reaches it, each answering with what it did. */
const entry = {
  home: async (commandId: string) => {
    const binding = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST');
    return request(`/projects/${binding.projectId}/threads/${binding.threadId}/messages`, 'POST', {
      commandId,
      text: 'How many loaves are on order?',
      mode: 'auto',
      sources: [],
      consent: true,
    });
  },
  conversation: (work: Work, commandId: string) =>
    request(`/projects/${work.projectId}/threads/${work.threadId}/messages`, 'POST', {
      commandId,
      text: 'Summarize the order.',
      mode: 'auto',
      sources: [],
      consent: true,
    }),
  build: (work: Work) =>
    request(`/projects/${work.projectId}/ask`, 'POST', { text: 'Draft the order checklist.', threadId: work.threadId, mode: 'build', consent: true }),
  loopStart: (work: Work, commandId: string) =>
    request(`/projects/${work.projectId}/loop/start`, 'POST', {
      protocolVersion: 1,
      commandId,
      taskId: work.taskId,
      goal: 'Read the order and report the count.',
      consent: true,
      sources: [],
      route: 'aws-bedrock',
      model: AWS_LUNA_MODEL,
      accountRoute: work.accountRoute,
    }),
  loopDrive: (work: Work, runId: string) =>
    engines.loopAdapter(
      'aws-bedrock',
      { projectId: work.projectId, runId, model: AWS_LUNA_MODEL, accountRoute: work.accountRoute, instructions: 'Check the order.' },
      new AbortController().signal,
    ),
  loopSeam: (work: Work) => app.locals.harness.loop.admit('aws-bedrock', { projectId: work.projectId, model: AWS_LUNA_MODEL, accountRoute: work.accountRoute }),
  // The member's team tools, as the host registers them; the scripted answer calls none of them.
  teamTurn: (work: Work, requestId: string) =>
    engines.generateModelApiTools(
      'aws-bedrock',
      {
        projectId: work.projectId,
        threadId: `team-${requestId}`,
        requestId,
        prompt: 'Draft the order checklist.',
        documents: [],
        instructions: 'You are a team member.',
        model: AWS_LUNA_MODEL,
        accountRoute: work.accountRoute,
      },
      teamToolRegistry({ projectId: work.projectId, member: {} as never, store: app.locals.store, service: {} as never }),
    ),
  preflight: (work: Work) => request(`/projects/${work.projectId}/threads/${work.threadId}/preflight`, 'POST', { text: PLAN }),
};
const refusedAs = async (response: Response, error: string) => {
  const body = await response.text();
  expect(response.status, body).toBe(403);
  expect(JSON.parse(body)).toMatchObject({ code: 'AGENT_NOT_INCLUDED', error });
};
const nothingSent = () => expect(calls).toEqual({ aws: 0, gateway: 0, provider: 0 });

/**
 * A managed call made straight to the account service's gateway, the way a member's own client
 * could make it, under an admission the service recorded for it. This computer's gate is not
 * asked, so what answers is the gateway's own check on the call.
 */
async function managedCall(email: string, organizationId: string, job: string) {
  const authorization = `Bearer ${await tokenFor(email)}`;
  const admitted = await cloud.handle(
    new Request(`http://faux.local/account/organizations/${organizationId}/agent-admissions`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'conversation', routeKind: 'managed', rootJobId: job }),
    }),
  );
  expect(admitted.status).toBe(200);
  const admission = (await admitted.json()) as { admissionId: string; decision: { admitted: boolean } };
  const response = await cloud.handle(
    new Request('http://faux.local/managed/v1/responses', {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'x-nectovia-organization': organizationId,
        'x-nectovia-admission': admission.admissionId,
        'x-nectovia-job': job,
        'x-nectovia-attempt': `${job}:1`,
        'x-nectovia-tier': 'efficient',
        'x-nectovia-usage-class': 'included-chat',
        'x-nectovia-policy-revision': String(policy.revision),
      },
      body: JSON.stringify({
        model: policy.tiers.efficient!.model,
        input: [
          { role: 'developer', content: 'Be brief.' },
          { role: 'user', content: [{ type: 'input_text', text: 'How many loaves are on order?' }] },
        ],
        reasoning: { effort: 'low' },
        include: ['reasoning.encrypted_content'],
        store: false,
        stream: true,
        parallel_tool_calls: false,
        max_output_tokens: 4_096,
      }),
    }),
  );
  return { admitted: admission.decision.admitted, response };
}
/** What the gateway opened and held for one business's job. */
const fundingOf = (organizationId: string, job: string) => {
  const { attempts, jobs } = cloud.store.snapshot().funding;
  const mine = (row: { organizationId: string; rootJobId: string }) => row.organizationId === organizationId && row.rootJobId === job;
  return { attempts: attempts.filter(mine), jobs: jobs.filter(mine) };
};

describe('the paid-abilities matrix', () => {
  test('Harbor Hardware, with no grant, is refused at every entry point before anything is sent', async () => {
    const harbor = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    expect(harbor.workspaces.map((row) => [row.organization.id, row.access?.agent.included])).toEqual([[orgs.harbor, false]]);
    const work = await workOnAws('Harbor order', await connectAws());

    await refusedAs(await entry.home('h-home'), AGENT_NOT_INCLUDED_REASON);
    await refusedAs(await entry.conversation(work, 'h-conversation'), AGENT_NOT_INCLUDED_REASON);
    await refusedAs(await entry.loopStart(work, 'h-loop'), AGENT_NOT_INCLUDED_REASON);
    await refusedAs(await entry.preflight(work), AGENT_NOT_INCLUDED_REASON);
    const refusal = { code: 'AGENT_NOT_INCLUDED', message: AGENT_NOT_INCLUDED_REASON };
    await expect(entry.loopDrive(work, 'loop-harbor-1')).rejects.toMatchObject(refusal);
    await expect(entry.loopSeam(work)).rejects.toMatchObject(refusal);
    await expect(entry.teamTurn(work, 'team-harbor-1')).rejects.toMatchObject({ message: AGENT_NOT_INCLUDED_REASON });
    // Build answers at once and runs the Work call after; the call is refused, and nothing is sent.
    const build = await entry.build(work);
    expect(build.status, await build.clone().text()).toBe(200);
    const { session } = (await build.json()) as { session: { id: string } };
    const settled = await vi.waitFor(
      async () => {
        const state = await api<{ sessions: { id: string; state: string }[] }>(`/projects/${work.projectId}/state`);
        const found = state.sessions.find((item) => item.id === session.id)!;
        expect(found.state).not.toMatch(/^(queued|working|preparing)$/);
        return found;
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(JSON.stringify(settled)).toContain(AGENT_NOT_INCLUDED_REASON);

    nothingSent();
    expect(port.calls).toHaveLength(0);
    // The service refused each one it was asked about, and admitted nothing.
    const recorded = await admissions(orgs.harbor);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((row) => row.decision === 'refused')).toBe(true);
  });

  test('Juniper Street Bakery, on Business, is admitted at every entry point', async () => {
    const juniper = await signIn(DEMO_ACCOUNTS.owner.email);
    expect(juniper.workspaces.map((row) => [row.organization.id, row.access?.agent.included])).toEqual([[orgs.juniper, true]]);
    const work = await workOnAws('Juniper order', await connectAws());

    // Home runs on the account service's gateway, which checks both features again on the call.
    const home = await entry.home('j-home');
    expect(home.status, await home.clone().text()).toBe(200);
    expect(await home.json()).toMatchObject({ answerText: ANSWER });
    expect(calls.gateway).toBeGreaterThan(0);
    expect(calls.provider).toBeGreaterThan(0);

    const conversation = await entry.conversation(work, 'j-conversation');
    expect(conversation.status, await conversation.clone().text()).toBe(200);
    expect(await conversation.json()).toMatchObject({ answerText: ANSWER });

    const preflight = await entry.preflight(work);
    expect(preflight.status, await preflight.clone().text()).toBe(200);
    expect(((await preflight.json()) as { advice: { status: string } }).advice.status).toBe('advised');
    expect(port.calls).toHaveLength(1);

    await expect(entry.loopSeam(work)).resolves.toMatchObject({ model: AWS_LUNA_MODEL, accountRoute: work.accountRoute });
    const adapter = await entry.loopDrive(work, 'loop-juniper-1');
    expect(typeof adapter.complete).toBe('function');
    const team = await entry.teamTurn(work, 'team-juniper-1');
    expect(team.text).toContain(ANSWER);

    const before = calls.aws;
    const build = await entry.build(work);
    expect(build.status, await build.clone().text()).toBe(200);
    await vi.waitFor(() => expect(calls.aws).toBeGreaterThan(before), { timeout: 10_000, interval: 50 });

    // A project runs one piece of work at a time, so the loop starts in a project of its own.
    const loop = await entry.loopStart(await workOnAws('Juniper loop', work.accountRoute), 'j-loop');
    expect(loop.status, await loop.clone().text()).toBe(200);

    const recorded = await admissions(orgs.juniper);
    const admitted = recorded.filter((row) => row.decision === 'admitted');
    for (const [surface, routeKind] of [
      ['conversation', 'managed'],
      ['conversation', 'byo'],
      ['other', 'byo'],
      ['loop', 'byo'],
      ['team', 'byo'],
      ['work', 'byo'],
    ])
      expect(admitted, `${surface} ${routeKind}`).toContainEqual(expect.objectContaining({ surface, routeKind }));
    expect(recorded.some((row) => row.decision === 'refused')).toBe(false);
  });

  test('a service agreement, the Agent without included AI usage: Diomedes-funded work is refused here and at the gateway, Agent work on its own connection runs, and Business passes the gateway', async () => {
    // Harbor on the Service agreement template, whose features leave out included AI usage.
    const billing = await tokenFor(DEMO_ACCOUNTS.staffBilling.email);
    const { grant } = await cloud.commercial.issueGrant(billing, orgs.harbor, {
      planId: 'service-agreement',
      source: 'service-agreement',
      reference: 'Test agreement',
      note: 'The quoted implementation.',
      validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(grant.features).toContain('nectovia-agent');
    expect(grant.features).not.toContain('managed-inference');
    const harbor = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    expect(harbor.workspaces[0].access).toMatchObject({ state: 'active', agent: { included: true } });
    expect(harbor.workspaces[0].access?.features).not.toContain('managed-inference');
    const work = await workOnAws('Harbor order', await connectAws());
    const before = (await admissions(orgs.harbor)).length;

    // On this computer, refused before the service records anything.
    await refusedAs(await entry.home('a-home'), MANAGED_USAGE_NOT_INCLUDED);
    expect(calls.gateway).toBe(0);
    expect(await admissions(orgs.harbor), 'nothing was recorded for the refused work').toHaveLength(before);

    // A managed call made anyway: the service admits the Agent, and the gateway refuses the call
    // before it opens a job or holds anything.
    const refused = await managedCall(DEMO_ACCOUNTS.harborOwner.email, orgs.harbor, 'harbor-job');
    expect(refused.admitted).toBe(true);
    expect(refused.response.status).toBe(403);
    expect(await refused.response.json()).toEqual({ error: { code: 'agent_not_included', message: GATEWAY_USAGE_NOT_INCLUDED } });
    expect(calls.provider).toBe(0);
    expect(fundingOf(orgs.harbor, 'harbor-job')).toEqual({ attempts: [], jobs: [] });

    // Agent work on the business's own connection is admitted and runs.
    const own = await entry.conversation(work, 'a-conversation');
    expect(own.status, await own.clone().text()).toBe(200);
    expect(await own.json()).toMatchObject({ answerText: ANSWER });
    expect(calls.aws).toBeGreaterThan(0);
    expect(await admissions(orgs.harbor)).toContainEqual(expect.objectContaining({ decision: 'admitted', surface: 'conversation', routeKind: 'byo' }));
    // So is a preflight on that connection: the owner's own route needs only the Agent.
    const preflight = await entry.preflight(work);
    expect(preflight.status, await preflight.clone().text()).toBe(200);
    expect(((await preflight.json()) as { advice: { status: string } }).advice.status).toBe('advised');
    expect(port.calls).toHaveLength(1);
    expect(await admissions(orgs.harbor)).toContainEqual(expect.objectContaining({ decision: 'admitted', surface: 'other', routeKind: 'byo' }));

    // The same call for Business passes the gateway and reaches the provider once.
    const passed = await managedCall(DEMO_ACCOUNTS.owner.email, orgs.juniper, 'juniper-job');
    expect(passed.admitted).toBe(true);
    expect(passed.response.status).toBe(200);
    expect(await passed.response.text()).toContain(ANSWER);
    expect(calls.provider).toBe(1);
    expect(fundingOf(orgs.juniper, 'juniper-job').attempts).toHaveLength(1);
  });
});
