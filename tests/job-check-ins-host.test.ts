/**
 * Job check-ins, through the real app over the faux account service (Andrew, 2026-10-05).
 *
 * A job is never cut off mid-call or mid-write. When its next step would pass the amount it checks in at,
 * it finishes what it was doing and asks whether to keep going; Keep going raises that one job by exactly
 * one more amount. This file drives the paths a person meets:
 *
 * - the amount: a business's own, set in Settings by an owner or admin, and read by the host from the
 *   account service;
 * - an attended message that stops at its check-in, shows the question and, on Keep going, continues under
 *   the same job at the account service (the one raise it asks for names that job and the cap it saw);
 * - unattended work (a Work loop) that stops at its check-in, waits in Needs you with its line, and is kept
 *   going by its Retry, which continues the same job.
 *
 * The gateway is a stub that answers "this job reached its check-in" on the Nth call, as the account service
 * does. Every person and figure is one of the faux seed's invented demo accounts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
import { loopRunId } from '../server/native-loop-routes';
import { loopOutcome, loopView } from '../shared/native-loop.js';
import { needsYou } from '../shared/needs-you.js';
import { creditAmount } from '../shared/managed-usage.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import type { AccountStateView } from '../shared/accounts';
import type { Project } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
type Item = Record<string, unknown>;
const credits = (n: number) => creditAmount(n);

let root: string;
let cloud: FauxCloud;
let juniper: string;
let engines: EngineService;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
/** The job id each call to the managed gateway named, in order. */
let gatewayJobs: (string | null)[];
let gatewayCalls: number;
/** The gateway call number (1-based) from which it answers "this job reached its check-in". Null: never. */
let stopFrom: number | null;
/** Which answerer serves the calls before the stop: a scripted text answer, or the faux account service. */
let answerer: 'scripted' | 'faux';
/** What the app sent to the account service to keep a job going, and whether a canned answer stands in. */
let keepGoing: { path: string; body: Item }[];
let keepGoingMode: 'real' | 'canned';

function scripted(request: Request, body: Item, n: number): Response {
  return sseResponse(
    responsesEvents({
      id: `resp_gw_${n}`,
      object: 'response',
      created_at: 1_790_000_000,
      model: String(body.model),
      status: 'completed',
      output: [
        {
          type: 'message',
          id: `msg_gw_${n}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Twelve loaves are on order.', annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 90,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 98,
      },
      incomplete_details: null,
      error: null,
    }),
    { 'x-nectovia-attempt': request.headers.get('x-nectovia-attempt') ?? '' },
  );
}
async function gateway(request: Request): Promise<Response> {
  const body = (await request.clone().json()) as Item;
  gatewayCalls += 1;
  gatewayJobs.push(request.headers.get('x-nectovia-job'));
  if (stopFrom !== null && gatewayCalls >= stopFrom)
    return new Response(JSON.stringify({ error: { code: 'cap_request_required', message: 'Gateway words about this job.' } }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  return answerer === 'scripted' ? scripted(request, body, gatewayCalls) : cloud.handle(request);
}

const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
const signIn = (email: string) =>
  api<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-job-check-ins-'));
  gatewayJobs = [];
  gatewayCalls = 0;
  stopFrom = null;
  answerer = 'scripted';
  keepGoing = [];
  keepGoingMode = 'real';
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/managed/v1/')) return gateway(req);
      if (url.pathname.endsWith('/check-ins/keep-going')) {
        const body = (await req.clone().json()) as Item;
        keepGoing.push({ path: url.pathname, body });
        if (keepGoingMode === 'canned')
          return new Response(
            JSON.stringify({ jobId: String(body.jobId), capMicroUsd: Number(body.atCapMicroUsd) * 2, addedCredits: Number(body.atCapMicroUsd) / 100_000, raised: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
      }
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
    modelApiTransport: (async () => {
      throw new Error('No provider is called in this file');
    }) as typeof globalThis.fetch,
    accounts: { backend },
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

type Role = 'owner' | 'admin' | 'member';
const EMAIL: Record<Role, string> = {
  owner: DEMO_ACCOUNTS.owner.email,
  admin: DEMO_ACCOUNTS.manager.email,
  member: DEMO_ACCOUNTS.employee.email,
};
const checkInsPath = () => `/workspace/organizations/${juniper}/job-check-ins`;
const AMOUNTS = { efficient: 40, focused: 60, thorough: 80 } as const;

type Binding = { projectId: string; threadId: string };
/** Home, linked to Juniper by its owner, then read by the person under test. */
async function homeFor(role: Role): Promise<Binding> {
  await signIn(DEMO_ACCOUNTS.owner.email);
  const binding = await api<Binding>('/home/conversation', 'POST');
  await api(`/workspace/organizations/${juniper}/output`, 'POST', { projectId: binding.projectId });
  await signIn(EMAIL[role]);
  return binding;
}
/** The business sets its own amounts, as an owner does in Settings. Leaves the owner signed in. */
async function setBusinessAmounts() {
  await signIn(DEMO_ACCOUNTS.owner.email);
  await api(checkInsPath(), 'POST', { amounts: AMOUNTS });
}
const say = (binding: Binding, commandId: string, text: string) =>
  request(`/projects/${binding.projectId}/threads/${binding.threadId}/messages`, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });

describe('the amount a business\'s jobs check in at', () => {
  test('an owner or admin reads it with its defaults and sets the business\'s own; a member does neither', async () => {
    await signIn(EMAIL.owner);
    const before = await api<any>(checkInsPath());
    expect(before.effective.amounts).toEqual({ efficient: 100, focused: 250, thorough: 500 });
    expect(before.defaults).toEqual({ efficient: 100, focused: 250, thorough: 500 });
    expect(before.override).toEqual({ efficient: null, focused: null, thorough: null });
    const saved = await api<any>(checkInsPath(), 'POST', { amounts: { efficient: 40, focused: null, thorough: 80 } });
    expect(saved.effective.amounts).toEqual({ efficient: 40, focused: 250, thorough: 80 });
    expect(saved.effective.source).toEqual({ efficient: 'business', focused: 'code', thorough: 'business' });
    // The defaults beside it do not move: the setting is this business's alone.
    expect(saved.defaults).toEqual({ efficient: 100, focused: 250, thorough: 500 });

    // An admin may change it too; the amount that was a business's own goes back with an empty box.
    await signIn(EMAIL.admin);
    expect((await api<any>(checkInsPath())).effective.amounts.efficient).toBe(40);
    const cleared = await api<any>(checkInsPath(), 'POST', { amounts: { efficient: null, focused: null, thorough: null } });
    expect(cleared.effective.amounts).toEqual({ efficient: 100, focused: 250, thorough: 500 });

    await signIn(EMAIL.member);
    expect((await request(checkInsPath())).status).toBe(403);
    expect((await request(checkInsPath(), 'POST', { amounts: AMOUNTS })).status).toBe(403);
  });

  test('an amount that is not whole credits, or a field it does not know, is refused', async () => {
    await signIn(EMAIL.owner);
    for (const bad of [
      { efficient: 0, focused: null, thorough: null },
      { efficient: 1.5, focused: null, thorough: null },
      { efficient: '40', focused: null, thorough: null },
      { efficient: 1_000_000, focused: null, thorough: null },
      { efficient: 40, focused: null },
    ]) {
      const refused = await request(checkInsPath(), 'POST', { amounts: bad });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'invalid_amount' });
    }
    const extra = await request(checkInsPath(), 'POST', { amounts: AMOUNTS, jobId: 'x' });
    expect(extra.status).toBe(400);
  });
});

describe('an attended message that reaches its check-in', () => {
  test('stops with the question, and Keep going continues the same job with one raise, once', async () => {
    const binding = await homeFor('owner');
    await setBusinessAmounts();
    keepGoingMode = 'canned';
    stopFrom = 1;
    const sent = await say(binding, 'm-1', 'How many loaves are on order?');
    // The one shape the Console reads, not a generic refusal; nothing of the step was sent.
    expect(sent.status).toBe(402);
    expect(await sent.json()).toMatchObject({ code: 'job_cap_reached' });
    expect(gatewayCalls).toBe(1);
    expect(keepGoing).toEqual([]);

    // The stop is recorded at the amount the job was held to, in the section 7 words.
    const status = await api<any>(`/projects/${binding.projectId}/jobs/m-1`);
    const amount = AMOUNTS[status.tier as keyof typeof AMOUNTS];
    expect(status.capMicroUsd).toBe(credits(amount));
    expect(status.overrun).toMatchObject({
      title: `This job has used ${amount} credits. Keep going?`,
      body: '',
      raise: `It can use ${amount} more before it checks in again.`,
      upgrade: null,
      actions: { goOver: 'Keep going', cancel: 'Stop here' },
    });

    // Keep going: the account service is told first, naming the job it metered and the cap the person saw.
    const kept = await api<any>(`/projects/${binding.projectId}/threads/${binding.threadId}/jobs/m-2/go-over`, 'POST', { fromJobId: 'm-1' });
    expect(kept).toMatchObject({ jobId: 'm-2', raised: true, capMicroUsd: credits(amount * 2) });
    expect(keepGoing).toHaveLength(1);
    expect(keepGoing[0].path).toBe(`/account/routing/organization/${juniper}/check-ins/keep-going`);
    expect(keepGoing[0].body).toEqual({ jobId: gatewayJobs[0], atCapMicroUsd: credits(amount) });
    expect(gatewayJobs[0]).toBeTruthy();

    // The message is then sent again as a new job that continues the first at the account service.
    stopFrom = null;
    const again = await say(binding, 'm-2', 'How many loaves are on order?');
    expect(again.status, await again.clone().text()).toBe(200);
    expect(gatewayJobs[1]).toBe(gatewayJobs[0]);

    // A stop raises one later job: asking again in its name is refused, and the person is told so.
    const third = await request(`/projects/${binding.projectId}/threads/${binding.threadId}/jobs/m-3/go-over`, 'POST', { fromJobId: 'm-1' });
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ code: 'stop_consumed' });
    expect((await api<any>(`/projects/${binding.projectId}/jobs/m-1`)).overrun).toBeNull();
  });

  test('a Keep going the account service refuses raises nothing: the stop stays open and nothing is sent again', async () => {
    const binding = await homeFor('owner');
    stopFrom = 1;
    await say(binding, 'm-1', 'How many loaves are on order?');
    // The raise is the account service's to make. It never opened this job (the stub gateway answered the
    // call), so it refuses, and the local record is not raised ahead of it.
    const refused = await request(`/projects/${binding.projectId}/threads/${binding.threadId}/jobs/m-2/go-over`, 'POST', { fromJobId: 'm-1' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    // The record of the stop is still open: the person can choose again, and no second job was raised.
    expect((await api<any>(`/projects/${binding.projectId}/jobs/m-1`)).overrun).not.toBeNull();
    expect(gatewayCalls).toBe(1);
  });

  test('choosing Stop here asks nobody for anything: nothing reaches the account service', async () => {
    const binding = await homeFor('owner');
    keepGoingMode = 'canned';
    stopFrom = 1;
    await say(binding, 'm-1', 'How many loaves are on order?');
    await api<any>(`/projects/${binding.projectId}/jobs/m-1`);
    expect(keepGoing).toEqual([]);
    expect(gatewayCalls).toBe(1);
  });
});

describe('unattended work that reaches its check-in', () => {
  async function project() {
    await signIn(DEMO_ACCOUNTS.owner.email);
    const made = await api<Project>('/projects', 'POST', { name: 'Juniper loop' });
    await api(`/workspace/organizations/${juniper}/output`, 'POST', { projectId: made.id });
    const policy = await api<{ version: number }>(`/projects/${made.id}/cloud-sharing`);
    await api(`/projects/${made.id}/cloud-sharing`, 'PUT', {
      expectedVersion: policy.version, routes: ['nectovia'], documents: [], shareConversationHistory: false, shareReviewPackets: false,
    });
    const taskId = (await api<{ id: string }>(`/projects/${made.id}/tasks`, 'POST', { name: 'Check the order' })).id;
    return { projectId: made.id, taskId };
  }
  const start = (projectId: string, taskId: string, commandId: string) =>
    request(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId, taskId, goal: 'Read the order and report the count.', route: 'nectovia', consent: true, sources: [],
    });
  const settled = (projectId: string, runId: string) =>
    vi.waitFor(
      async () =>
        expect(['cancelled', 'failed', 'reconcile_required', 'completed']).toContain((await app.locals.harness.get(projectId, runId)).state),
      { timeout: 20_000 },
    );

  test('the run stops where it is, waits in Needs you with the line, and its Retry keeps the same job going', async () => {
    answerer = 'faux';
    const { projectId, taskId } = await project();
    await setBusinessAmounts();
    // The plan is answered; the first act call is where the job checks in.
    stopFrom = 2;
    const commandId = 'check-in-loop';
    const started = await start(projectId, taskId, commandId);
    expect(started.status, await started.clone().text()).toBe(200);
    const runId = loopRunId(projectId, commandId);
    await settled(projectId, runId);
    await app.locals.harness.bridge.flush();
    const run = await app.locals.harness.get(projectId, runId);
    expect(run.state).toBe('cancelled');
    expect(run.steps.map((step: { intent: { stepId: string }; state: string }) => `${step.intent.stepId}:${step.state}`)).toEqual([
      'loop:context:succeeded',
      'context:plan:succeeded',
      'model:plan:succeeded',
      'plan:succeeded',
      'context:0:succeeded',
      'model:0:failed',
      'stop:check-in:succeeded',
    ]);

    // The record, the outcome and the session line all carry the one section 7 sentence, at the amount reached.
    const status = await api<any>(`/projects/${projectId}/jobs/${runId}`);
    const amount = AMOUNTS[status.tier as keyof typeof AMOUNTS];
    const line = `A routine stopped to check in after ${amount} credits.`;
    const view = loopView(run);
    expect(view.stop).toMatchObject({ reason: 'check-in', detail: line });
    expect(loopOutcome(view, null)).toEqual({ state: 'stopped-limit', label: 'Stopped: checking in', sentence: line });
    const state = app.locals.store.state(projectId);
    const session = state.sessions.find((item: { taskId: string }) => item.taskId === taskId)!;
    expect(session.state).toBe('stopped');
    expect(session.log.filter((entry: { level: string }) => entry.level === 'plain').map((entry: { sentence: string }) => entry.sentence).at(-1)).toBe(line);

    // It waits in Needs you, with that line, not as a failure.
    const task = state.tasks.find((item: { id: string }) => item.id === taskId)!;
    expect(task).toMatchObject({ state: 'waiting', reason: 'check-in' });
    expect(needsYou(state)).toEqual([expect.objectContaining({ kind: 'review', taskId, detail: line })]);
    expect(keepGoing).toEqual([]);

    // Keep going there is the loop's Retry: the account service raises that job by one more amount, and the
    // new attempt continues it, so what the first attempt used still counts against it.
    stopFrom = null;
    const firstJob = gatewayJobs[0];
    expect(firstJob).toBeTruthy();
    // Retry asks for what the run was admitted with, read fresh: the route is on and set up for this business,
    // on the model the run used.
    const store = app.locals.store;
    const model = session.origin?.model.requested as string;
    expect(model).toBeTruthy();
    await store.locked(() =>
      store.saveSettings({
        ...store.settings,
        services: { ...store.settings.services, nectovia: true, nectoviaAccountRoute: `nectovia:${juniper}`, nectoviaModel: model },
      }),
    );
    const retried = await api<any>(`/projects/${projectId}/controls`, 'POST', {
      protocolVersion: 1, commandId: 'keep-going-1', taskId, control: 'retry', sessionId: session.id,
    });
    expect(retried.receipt.outcome, JSON.stringify(retried)).toBe('applied');
    expect(keepGoing).toHaveLength(1);
    expect(keepGoing[0].body).toEqual({ jobId: firstJob, atCapMicroUsd: credits(amount) });
    // The new attempt is its own run and session; it runs to the end under the same job.
    const second = (await app.locals.harness.list(projectId)).find((item: { id: string }) => item.id !== runId)!.id;
    await settled(projectId, second);
    expect((await app.locals.harness.get(projectId, second)).state).toBe('completed');
    expect(new Set(gatewayJobs.slice(1))).toEqual(new Set([firstJob]));
  });
});
