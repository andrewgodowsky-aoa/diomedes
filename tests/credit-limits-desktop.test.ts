/**
 * A member's monthly credit limit, as the desktop meets it (Andrew, 2026-10-01).
 *
 * The account service enforces the limit where credits are held. This file covers what the desktop does
 * with that: it reads the refusal as a stop with the service's own words, lets the person ask an owner or
 * admin, and lets an owner or admin decide, all through this app's own routes and the faux cloud's real
 * account service. Every person and figure is one of the faux seed's invented demo accounts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelMessage } from 'ai';
import { ApiError as ClientApiError } from '../client/api';
import {
  afterMemberLimitStop,
  isMemberLimitStop,
  memberLimitPrompt,
  type MemberLimitChoice,
  type MemberLimitPrompt,
} from '../client/job-cap-gate';
import type { AccountBackend } from '../server/accounts/backend.js';
import { ControlPlaneClient } from '../server/accounts/client';
import { AccountSessionService } from '../server/accounts/session.js';
import { mountCreditLimitRoutes, NOT_SIGNED_IN_REASON } from '../server/credit-limit-routes.js';
import { exposureAttempt } from '../server/engines/aws-bedrock';
import { CONVERSATION_LIMITS, ModelApiError } from '../server/engines/model-api-core';
import { gatewayRefusal, nectoviaConnectionId, nectoviaRateCard, respondNectovia, type NectoviaPolicy } from '../server/engines/nectovia';
import { mountInteractionRoutes } from '../server/engines/interaction-routes.js';
import { EngineError, MEMBER_LIMIT } from '../server/engines/process.js';
import type { InteractionTurns } from '../server/interaction-service.js';
import { ApiError } from '../server/paths.js';
import { SpendExposure } from '../server/spend-exposure';
import type { WorkspaceService } from '../server/workspaces.js';
import { MEMBER_LIMIT_REACHED } from '../shared/credit-allotments';
import { creditAmount, micro } from '../shared/managed-usage';
import { canManageMemberLimits } from '../shared/workspaces';
import { STRICT_RESTRICTIONS, type ModelBinding, type ProviderConnection } from '../shared/routing-policy';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';

// ---- the client's decisions ---------------------------------------------------------------------------

describe('the stop in the client', () => {
  const SAID = 'This step needs up to 2 credits, and you’ve used 1 of the 1 set for you this month. An owner or admin can approve more.';

  test('only the host\'s member-limit refusal counts as this stop', () => {
    expect(isMemberLimitStop(new ClientApiError('stop', 402, { code: MEMBER_LIMIT_REACHED }))).toBe(true);
    expect(isMemberLimitStop(new ClientApiError('cap', 402, { code: 'job_cap_reached' }))).toBe(false);
    expect(isMemberLimitStop(new ClientApiError('later', 503, { code: MEMBER_LIMIT_REACHED }))).toBe(false);
    expect(isMemberLimitStop(new Error(MEMBER_LIMIT_REACHED))).toBe(false);
  });

  test('the prompt carries the service\'s sentence unchanged and adds no figure of its own', () => {
    const prompt = memberLimitPrompt(SAID);
    expect(prompt.body).toBe(SAID);
    for (const text of [prompt.title, prompt.job, prompt.month]) {
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/[–—$]/);
    }
  });

  function person(...answers: MemberLimitChoice[]) {
    const shown: MemberLimitPrompt[] = [];
    return {
      shown,
      ask: async (prompt: MemberLimitPrompt) => {
        shown.push(prompt);
        const next = answers.shift();
        if (!next) throw new Error('Asked more than expected.');
        return next;
      },
    };
  }

  test('asking for this job, or for the month, sends that kind and nothing else', async () => {
    for (const kind of ['job', 'month'] as const) {
      const who = person(kind);
      const request = vi.fn(async () => undefined);
      expect(await afterMemberLimitStop(SAID, { ask: who.ask, request })).toBe('asked');
      expect(request).toHaveBeenCalledExactlyOnceWith(kind);
      expect(who.shown[0].body).toBe(SAID);
    }
  });

  test('Cancel asks nobody', async () => {
    const request = vi.fn(async () => undefined);
    expect(await afterMemberLimitStop(SAID, { ask: person('cancel').ask, request })).toBe('cancelled');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('the refusal at the model boundary', () => {
  test('the gateway\'s code becomes the Agent\'s own, in the service\'s words', () => {
    const said = 'This step needs up to 2 credits, and you’ve used 9 of the 10 set for you this month. An owner or admin can approve more.';
    expect(gatewayRefusal(402, { code: MEMBER_LIMIT_REACHED, message: said }, 'efficient')).toEqual({ code: 'nectovia_member_limit_reached', message: said });
  });

  test('without words from the service it still says who can approve', () => {
    const refusal = gatewayRefusal(402, { code: MEMBER_LIMIT_REACHED, message: '  ' }, 'focused')!;
    expect(refusal.code).toBe('nectovia_member_limit_reached');
    expect(refusal.message).toMatch(/owner or admin/);
    expect(refusal.message).toMatch(/An owner or admin can approve more\.$/);
    expect(refusal.message).not.toMatch(/nothing was/i);
    expect(refusal.message).not.toMatch(/[–—$]/);
  });

  test('a limit is not mistaken for the job cap or the pool being used up', () => {
    expect(gatewayRefusal(402, { code: 'cap_request_required', message: 'x' }, 'efficient')!.code).toBe('nectovia_cap_request_required');
    expect(gatewayRefusal(402, { code: 'insufficient_allowance', message: 'x' }, 'efficient')!.code).toBe('nectovia_insufficient_allowance');
  });
});

// ---- the refusal reaches the Console in one shape ----------------------------------------------------

// ---- the ask flow, end to end on the faux cloud --------------------------------------------------------

const connection: ProviderConnection = { id: 'fixture-azure', revision: 1, label: 'Synthetic Azure', provider: 'azure-openai',
  secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture', enabled: true,
  resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary', 'backup'] };
const answer = () => new Response([
  { id: 'fixture-response', model: 'fixture-non-luna', choices: [{ delta: { content: 'A complete answer.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-provider-request' } });

let cloud: FauxCloud, client: ControlPlaneClient, exposure: SpendExposure, directory: string, connectionId: string;
let org: string, staff: string, policy: NectoviaPolicy, sent: string[];
let servers: Server[];
const tokens: Record<string, string> = {};

async function api(method: string, url: string, bearer: string, value?: unknown) {
  const response = await cloud.handle(new Request(`${client.base}${url}`, { method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) }));
  const body = await response.json(); expect(response.ok, JSON.stringify(body)).toBe(true); return body;
}

/** A signed-in desktop session for one demo person, and this app's credit-limit routes served over it. */
async function desktop(email: string, signedIn = true) {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) => cloud.handle(request)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, directory, null);
  await session.init();
  await session.signIn({ email, password: FAUX_DEMO_PASSWORD, remember: false });
  const role = ({ [DEMO_ACCOUNTS.owner.email]: 'owner', [DEMO_ACCOUNTS.manager.email]: 'admin', [DEMO_ACCOUNTS.employee.email]: 'member' } as Record<string, 'owner' | 'admin' | 'member'>)[email];
  const workspaces = {
    assertMine: () => {},
    assertCanManageMemberLimits: () => {
      if (!canManageMemberLimits({ role, state: 'active' } as never)) throw new ApiError(403, 'Only an owner or an admin can do that for this business.', { code: 'not_owner_or_admin' });
    },
  } as unknown as Pick<WorkspaceService, 'assertMine' | 'assertCanManageMemberLimits'>;
  const app = express();
  app.use(express.json());
  mountCreditLimitRoutes(app, workspaces, signedIn ? session : null);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...error.details });
    else res.status(500).json({ error: String(error) });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace/organizations/${org}`;
  const call = async (method: string, tail: string, body?: unknown) => {
    const response = await fetch(`${base}${tail}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { session, call, personId: session.personId() };
}

beforeEach(async () => {
  sent = []; servers = [];
  const now = Date.now(), at = new Date(now).toISOString(), until = new Date(now + 3_600_000).toISOString();
  cloud = await createFauxCloud({ file: null, now: () => now, passwordIterations: 1000, managed: {
    bindings: { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'synthetic-provider-key' },
    transport: async (_url, init) => { const body = JSON.parse(String(init?.body)); sent.push(body.model); return answer(); },
  } });
  org = (await seedDemo(cloud)).organizations!.juniper;
  client = new ControlPlaneClient('http://127.0.0.1:8795', request => cloud.handle(request));
  const login = async (email: string) => (await api('POST', '/auth/sign-in', '', { email, password: FAUX_DEMO_PASSWORD })).accessToken as string;
  for (const [key, account] of Object.entries({ owner: DEMO_ACCOUNTS.owner, manager: DEMO_ACCOUNTS.manager, employee: DEMO_ACCOUNTS.employee }))
    tokens[key] = await login(account.email);
  staff = await login(DEMO_ACCOUNTS.staffRouting.email);
  const binding: ModelBinding = { connectionId: connection.id, connectionRevision: 1, protocol: 'chat-completions', deployment: 'primary',
    modelVersion: 'fixture-non-luna', upstreamEndpoint: null, capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
    qualification: { id: 'fixture', evidence: 'Synthetic only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 1 },
    access: { state: 'ready', evidence: 'Synthetic only', validUntil: until, availableRequests: 10 },
    privacy: { connectionRevision: 1, modelVersion: 'fixture-non-luna', protocol: 'chat-completions', evidence: 'Synthetic only', validUntil: until,
      ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zdr', zeroRetention: true, training: false,
      contentLogging: false, caching: 'off', transientCacheEvidence: null, features: ['text', 'tools'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false },
    health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Synthetic only' },
    price: { version: 'fixture-v1', observedAt: at, validUntil: until, evidence: 'Synthetic only', inputMicroUsdPerMillion: 100_000,
      outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000, cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000,
      requestFeeMicroUsd: 2, longContext: [] } };
  for (const id of ['primary', 'backup']) await api('POST', '/ops/routes', staff, { id, provider: 'azure-openai', model: 'fixture-non-luna',
    label: id, region: 'US', processing: 'Synthetic only', status: 'qualified', evidence: 'Synthetic only', binding: { ...binding, deployment: id } });
  await client.acceptRoutingPreference(tokens.owner, { scope: { kind: 'organization', id: org }, baseRevision: 0, profile: 'strict', restrictions: STRICT_RESTRICTIONS,
    consentVersion: 'NC-SETUP-2026-09-27.1', exceptions: [], acknowledge: true });
  const tier = { primary: 'primary', backups: ['backup'], fallbackEnabled: true, maxAttempts: 2,
    cost: { sameOrLower: true, qualityFloor: 1, maxAttemptMicroUsd: null } };
  await api('POST', '/ops/routing/scopes/publish', staff, { scope: { kind: 'global' }, baseRevision: 1, baseGlobalRevision: 1,
    routing: { efficient: tier, focused: tier, thorough: tier }, note: 'Synthetic limit test' });
  const resolved = await client.scopedRoutingPolicy(tokens.employee, { kind: 'organization', id: org });
  policy = { revision: resolved.revision, tiers: resolved.tiers, resolved };
  directory = await mkdtemp(path.join(os.tmpdir(), 'credit-limits-desktop-'));
  exposure = new SpendExposure(directory); await exposure.init();
  connectionId = nectoviaConnectionId(org, new Date(now));
  await exposure.setCap(connectionId, micro(1_000_000), { approvedBy: 'test host', note: 'Disposable guard' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await cloud?.idle();
  if (directory) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('credit-limits-desktop-')) throw new Error('Unexpected test directory.');
    await rm(directory, { recursive: true, force: true });
  }
});

/** One step of Priya's work through the managed gateway, as the desktop sends it. */
async function step(job: string, stepId: string) {
  const messages: ModelMessage[] = [{ role: 'user', content: 'Hello.' }];
  const admission = await client.admitScopedAgent(tokens.employee, { kind: 'organization', id: org }, { surface: 'conversation', routeKind: 'managed', rootJobId: job });
  return respondNectovia({ base: client.base, account: { policy: () => policy, refreshPolicy: async () => policy }, connectionId,
    model: 'fixture-non-luna', managed: { admissionId: admission.admissionId, organizationId: org, scope: { kind: 'organization', id: org },
      policyRevision: policy.revision, routing: policy.resolved, tier: 'efficient', usageClass: 'metered-work', rootJobId: job },
    token: tokens.employee, card: nectoviaRateCard('fixture-non-luna', policy), exposure, attempt: exposureAttempt(job, stepId, messages),
    instructions: 'Answer the request.', messages, tools: [], effort: 'low', limits: CONVERSATION_LIMITS,
    signal: new AbortController().signal, transport: async (url, init) => cloud.handle(new Request(url, init)) });
}
async function refusedStep(job: string, stepId: string) {
  try { await step(job, stepId); } catch (error) {
    expect(error).toBeInstanceOf(ModelApiError);
    return error as ModelApiError;
  }
  throw new Error('Expected the step to be refused.');
}

describe('a member at their own limit asks, and an owner decides', () => {
  const JOB = 'limit-job-1';

  test('the whole flow: set, stop, ask, approve one job, send again', async () => {
    const maya = await desktop(DEMO_ACCOUNTS.owner.email);
    const priya = await desktop(DEMO_ACCOUNTS.employee.email);

    // Before any limit is set the whole plan allowance is hers, so the step goes through.
    expect((await step('open-job', 'step-1')).outcome).toMatchObject({ kind: 'final' });
    const before = sent.length;

    // Maya sets a limit for Priya through this app's route. Its figure is hers; no other is built in.
    const set = await maya.call('POST', '/credit-limits', { subject: { kind: 'person', personId: priya.personId }, mode: 'limit', limitMicroUsd: 100 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    // The next step is refused before anything is sent, in the service's words.
    const refusal = await refusedStep(JOB, 'step-1');
    expect(refusal.code).toBe('nectovia_member_limit_reached');
    expect(refusal.message).toMatch(/An owner or admin can approve more\.$/);
    expect(refusal.message).not.toMatch(/\$|dollar|[–—]/i);
    expect(sent).toHaveLength(before);

    // Priya sees her own use against her own limit and nothing about the pool or anyone else.
    const mine = await priya.call('GET', '/credit-usage/mine');
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ state: 'ready' });
    expect(JSON.stringify(mine.body)).not.toMatch(/pool|poolBalance|remainingPool/i);

    // She asks for this job. The ask names a kind and a job, never an amount.
    const asked = await priya.call('POST', '/credit-limit-requests', { requestId: 'ask-1', kind: 'job', jobId: JOB });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ requestId: 'ask-1', state: 'pending', kind: 'job' });
    // Asking again with the same id is the same ask.
    expect((await priya.call('POST', '/credit-limit-requests', { requestId: 'ask-1', kind: 'job', jobId: JOB })).body).toMatchObject({ requestId: 'ask-1', state: 'pending' });

    // She cannot decide it, change limits, or read others.
    expect((await priya.call('POST', '/credit-limit-requests/ask-1/decision', { approve: true })).status).toBe(403);
    expect((await priya.call('POST', '/credit-limits', { subject: { kind: 'person', personId: priya.personId }, mode: 'unlimited' })).status).toBe(403);
    expect((await priya.call('GET', '/credit-usage/members')).status).toBe(403);
    expect((await priya.call('GET', '/credit-limits')).status).toBe(403);

    // Maya sees the ask and approves that one job.
    const pending = await maya.call('GET', '/credit-limit-requests');
    expect(pending.body.requests.map((row: { requestId: string; state: string }) => [row.requestId, row.state])).toEqual([['ask-1', 'pending']]);
    const approved = await maya.call('POST', '/credit-limit-requests/ask-1/decision', { approve: true });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ state: 'approved' });

    // The same job goes ahead now; another job is still stopped at her limit.
    expect((await step(JOB, 'step-2')).outcome).toMatchObject({ kind: 'final' });
    expect((await refusedStep('limit-job-2', 'step-1')).code).toBe('nectovia_member_limit_reached');

    // Maya reads who used what, in micro-USD and never dollars.
    const report = await maya.call('GET', '/credit-usage/members');
    expect(report.status).toBe(200);
    expect(JSON.stringify(report.body)).not.toMatch(/dollar|\$/i);
    const row = report.body.members.find((member: { personId: string }) => member.personId === priya.personId);
    expect(row).toBeTruthy();
    expect(row.usage.usedMicroUsd).toBeGreaterThan(0);
  });

  test('a month raise sized by the approver lifts every job for the month', async () => {
    const maya = await desktop(DEMO_ACCOUNTS.owner.email);
    const priya = await desktop(DEMO_ACCOUNTS.employee.email);
    await maya.call('POST', '/credit-limits', { subject: { kind: 'person', personId: priya.personId }, mode: 'limit', limitMicroUsd: 100 });
    expect((await refusedStep('month-job-1', 'step-1')).code).toBe('nectovia_member_limit_reached');
    const asked = await priya.call('POST', '/credit-limit-requests', { requestId: 'ask-month', kind: 'month' });
    expect(asked.body).toMatchObject({ state: 'pending', kind: 'month' });
    // The approver names what to add; the ask never does.
    expect((await maya.call('POST', '/credit-limit-requests/ask-month/decision', { approve: true })).status).toBe(422);
    const approved = await maya.call('POST', '/credit-limit-requests/ask-month/decision', { approve: true, extraMicroUsd: creditAmount(5) });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await step('month-job-1', 'step-2')).outcome).toMatchObject({ kind: 'final' });
    expect((await step('month-job-2', 'step-1')).outcome).toMatchObject({ kind: 'final' });
  });

  test('a denial leaves the stop in place', async () => {
    const maya = await desktop(DEMO_ACCOUNTS.owner.email);
    const priya = await desktop(DEMO_ACCOUNTS.employee.email);
    await maya.call('POST', '/credit-limits', { subject: { kind: 'person', personId: priya.personId }, mode: 'limit', limitMicroUsd: 100 });
    await refusedStep(JOB, 'step-1');
    await priya.call('POST', '/credit-limit-requests', { requestId: 'ask-no', kind: 'job', jobId: JOB });
    expect((await maya.call('POST', '/credit-limit-requests/ask-no/decision', { approve: false })).body).toMatchObject({ state: 'denied' });
    expect((await refusedStep(JOB, 'step-2')).code).toBe('nectovia_member_limit_reached');
  });

  test('an admin approves a member\'s ask but cannot approve their own', async () => {
    const maya = await desktop(DEMO_ACCOUNTS.owner.email);
    const sam = await desktop(DEMO_ACCOUNTS.manager.email);
    const priya = await desktop(DEMO_ACCOUNTS.employee.email);
    await maya.call('POST', '/credit-limits', { subject: { kind: 'person', personId: priya.personId }, mode: 'limit', limitMicroUsd: 100 });
    await refusedStep(JOB, 'step-1');
    await priya.call('POST', '/credit-limit-requests', { requestId: 'ask-by-priya', kind: 'job', jobId: JOB });
    expect((await sam.call('POST', '/credit-limit-requests/ask-by-priya/decision', { approve: true })).status).toBe(200);
    await maya.call('POST', '/credit-limits', { subject: { kind: 'role', role: 'admin' }, mode: 'limit', limitMicroUsd: 100 });
    const own = await sam.call('POST', '/credit-limit-requests', { requestId: 'ask-by-sam', kind: 'month' });
    expect(own.status).toBe(200);
    expect((await sam.call('POST', '/credit-limit-requests/ask-by-sam/decision', { approve: true, extraMicroUsd: creditAmount(1) })).status).toBe(403);
    expect((await maya.call('POST', '/credit-limit-requests/ask-by-sam/decision', { approve: true, extraMicroUsd: creditAmount(1) })).status).toBe(200);
  });

  test('a request names nothing only the account service decides', async () => {
    const maya = await desktop(DEMO_ACCOUNTS.owner.email);
    const priya = await desktop(DEMO_ACCOUNTS.employee.email);
    expect((await priya.call('POST', '/credit-limit-requests', { requestId: 'x1', kind: 'month', extraMicroUsd: 5 })).body.code).toBe('client_field_refused');
    expect((await priya.call('POST', '/credit-limit-requests', { requestId: 'x2', kind: 'month', personId: 'someone-else' })).body.code).toBe('client_field_refused');
    expect((await maya.call('POST', '/credit-limits', { subject: { kind: 'role', role: 'owner' }, mode: 'unlimited' })).status).toBe(400);
    expect((await maya.call('POST', '/credit-limits', { subject: { kind: 'role', role: 'member' }, mode: 'limit', limitMicroUsd: -1 })).status).toBe(400);
    expect((await maya.call('POST', '/credit-limits', { subject: { kind: 'role', role: 'member' }, mode: 'limit', limitMicroUsd: 5, tenantId: 'other' })).body.code).toBe('client_field_refused');
  });

  test('without an account sign-in the routes say so and decide nothing', async () => {
    const out = await desktop(DEMO_ACCOUNTS.owner.email, false);
    expect((await out.call('GET', '/credit-usage/mine')).body).toMatchObject({ state: 'unavailable', reason: NOT_SIGNED_IN_REASON });
    expect((await out.call('POST', '/credit-limit-requests', { requestId: 'x', kind: 'month' })).status).toBe(401);
    expect((await out.call('GET', '/credit-limits')).status).toBe(401);
  });
});

describe('a stop reaches the Console in one shape', () => {
  async function send(thrown: unknown) {
    const app = express();
    app.use(express.json());
    const turns = { message: async () => { throw thrown; } } as unknown as InteractionTurns;
    mountInteractionRoutes(app, turns, { authorize: async () => undefined });
    app.use((error: { status?: number; message: string; details?: object }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message, ...(error.details ?? {}) });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/p/threads/t/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: 'cmd-1', text: 'Hello', mode: 'ask', sources: [], consent: true }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  test('the messages route answers a member-limit stop as 402 member_limit_reached, in the service’s words', async () => {
    const said = 'This step needs up to 2 credits, and you’ve used 9 of the 10 set for you this month. An owner or admin can approve more.';
    const { status, body } = await send(new EngineError(MEMBER_LIMIT, said, false));
    expect(status).toBe(402);
    expect(body).toMatchObject({ error: said, code: MEMBER_LIMIT_REACHED });
    // The client treats exactly that shape as the stop that offers to ask.
    expect(isMemberLimitStop(new ClientApiError(String(body.error), status, body))).toBe(true);
  });

  test('a job-cap stop keeps its own shape, and an ordinary refusal is not taken for either', async () => {
    expect((await send(new EngineError('JOB_CAP', 'This job would pass its cap.', false))).body).toMatchObject({ code: 'job_cap_reached' });
    const other = await send(new EngineError('ROUTE_REFUSED', 'Not available.', true));
    expect(other.body.code).not.toBe(MEMBER_LIMIT_REACHED);
  });
});
