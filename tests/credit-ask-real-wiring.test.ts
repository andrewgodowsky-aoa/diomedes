/**
 * The ask a member's own credit limit offers, through the real app (Andrew, 2026-10-01).
 *
 * credit-asks and credit-limits-desktop stub where a message ran. This file does not: a Nectovia turn
 * is sent through the real app against the faux cloud's real managed gateway, a member's limit
 * refuses its step, and the Console's ask route resolves the job from the project and the command id
 * the way the app does. The job it names must be the one the gateway refused. Every person and figure
 * is one of the faux seed's invented demo accounts.
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
import { digest } from '../server/harness/policy.js';
import { turnRunId } from '../server/harness/model-session-run.js';
import { MEMBER_LIMIT_REACHED } from '../shared/credit-allotments';
import { STRICT_RESTRICTIONS, type ModelBinding, type ProviderConnection } from '../shared/routing-policy';
import type { AccountStateView } from '../shared/accounts';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const ACCOUNT_SERVICE = 'http://faux.local';

const connection: ProviderConnection = { id: 'fixture-azure', revision: 1, label: 'Synthetic Azure', provider: 'azure-openai',
  secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture', enabled: true,
  resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary', 'backup'] };
const answer = () => new Response([
  { id: 'fixture-response', model: 'fixture-non-luna', choices: [{ delta: { content: 'A complete answer.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-provider-request' } });

type GatewayCall = { job: string; admission: string; status: number; code: string | null };

let root: string, cloud: FauxCloud, backend: AccountBackend, app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
let base: string, org: string, staff: string, sent: string[], gateway: GatewayCall[];
const tokens: Record<string, string> = {};

async function cloudApi(method: string, url: string, bearer: string, value?: unknown) {
  const response = await cloud.handle(new Request(`${ACCOUNT_SERVICE}${url}`, { method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) }));
  const body = await response.json(); expect(response.ok, JSON.stringify(body)).toBe(true); return body;
}
const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
type Binding = { projectId: string; threadId: string };
const say = (binding: Binding, commandId: string, text: string) =>
  request(`/projects/${binding.projectId}/threads/${binding.threadId}/messages`, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });
const ask = async (binding: Binding, commandId: string, body: unknown) => {
  const response = await request(`/projects/${binding.projectId}/jobs/${commandId}/credit-ask`, 'POST', body);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
/** Every ask the control plane holds for this business, as the owner reads them. */
const asksHeld = async () => (await cloud.handle(new Request(`${ACCOUNT_SERVICE}/account/organizations/${org}/credit-limit-requests`,
  { headers: { authorization: `Bearer ${tokens.owner}` } })).then((response) => response.json())) as { requests: { requestId: string; kind: string; jobId: string | null; state: string }[] };

async function open() {
  app = await createApp({
    dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null, secretBox: testOnlySecretBox(),
    modelApiTransport: (async () => { throw new Error('No provider is called directly in this file'); }) as typeof globalThis.fetch,
    accounts: { backend },
  });
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-credit-ask-wiring-'));
  sent = []; gateway = [];
  const now = Date.now(), at = new Date(now).toISOString(), until = new Date(now + 3_600_000).toISOString();
  cloud = await createFauxCloud({ file: null, now: () => now, passwordIterations: 1000, managed: {
    bindings: { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'synthetic-provider-key' },
    transport: async (_url, init) => { const body = JSON.parse(String(init?.body)); sent.push(body.model); return answer(); },
  } });
  org = (await seedDemo(cloud)).organizations!.juniper;
  const login = async (email: string) => (await cloudApi('POST', '/auth/sign-in', '', { email, password: FAUX_DEMO_PASSWORD })).accessToken as string;
  for (const [key, account] of Object.entries({ owner: DEMO_ACCOUNTS.owner, employee: DEMO_ACCOUNTS.employee })) tokens[key] = await login(account.email);
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
  for (const id of ['primary', 'backup']) await cloudApi('POST', '/ops/routes', staff, { id, provider: 'azure-openai', model: 'fixture-non-luna',
    label: id, region: 'US', processing: 'Synthetic only', status: 'qualified', evidence: 'Synthetic only', binding: { ...binding, deployment: id } });
  const client = new ControlPlaneClient(ACCOUNT_SERVICE, (req) => cloud.handle(req));
  await client.acceptRoutingPreference(tokens.owner, { scope: { kind: 'organization', id: org }, baseRevision: 0, profile: 'strict', restrictions: STRICT_RESTRICTIONS,
    consentVersion: 'NC-SETUP-2026-09-27.1', exceptions: [], acknowledge: true });
  const tier = { primary: 'primary', backups: ['backup'], fallbackEnabled: true, maxAttempts: 2, cost: { sameOrLower: true, qualityFloor: 1, maxAttemptMicroUsd: null } };
  await cloudApi('POST', '/ops/routing/scopes/publish', staff, { scope: { kind: 'global' }, baseRevision: 1, baseGlobalRevision: 1,
    routing: { efficient: tier, focused: tier, thorough: tier }, note: 'Synthetic wiring test' });
  backend = {
    // The desktop's own client reaches the real account service; each managed call is noted on the way,
    // with the job the desktop named and what the gateway answered.
    client: new ControlPlaneClient(ACCOUNT_SERVICE, async (req) => {
      if (!new URL(req.url).pathname.startsWith('/managed/v1/')) return cloud.handle(req);
      const job = req.headers.get('x-nectovia-job') ?? '', admission = req.headers.get('x-nectovia-admission') ?? '';
      const response = await cloud.handle(req);
      const said = response.status === 200 ? null : ((await response.clone().json().catch(() => null)) as { error?: { code?: string }; code?: string } | null);
      gateway.push({ job, admission, status: response.status, code: said ? (said.error?.code ?? said.code ?? null) : null });
      return response;
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  await open();
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await cloud?.idle();
  await fs.rm(root, { recursive: true, force: true });
});

/** Priya, a member, signed in on this app, on a Home an owner linked to the business (a member cannot link one). */
async function priyaHome(): Promise<Binding> {
  await api<AccountStateView>('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: false });
  const binding = await api<Binding>('/home/conversation', 'POST');
  await api(`/workspace/organizations/${org}/output`, 'POST', { projectId: binding.projectId });
  await api('/account/sign-out', 'POST');
  await api<AccountStateView>('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.employee.email, password: FAUX_DEMO_PASSWORD, remember: false });
  return binding;
}
const limitPriya = async (limitMicroUsd: number) => {
  const state = await api<AccountStateView>('/account');
  const personId = (state as unknown as { person?: { id?: string } }).person?.id;
  expect(personId, JSON.stringify(state).slice(0, 300)).toBeTruthy();
  await cloudApi('POST', `/account/organizations/${org}/credit-limits`, tokens.owner, { subject: { kind: 'person', personId }, mode: 'limit', limitMicroUsd });
};

describe('the ask from a stopped message, through the real app', () => {
  test('names the job the gateway refused, and records one ask', async () => {
    const binding = await priyaHome();
    await limitPriya(100);
    const stopped = await say(binding, 'm-stopped', 'How many loaves are on order?');
    const body = (await stopped.json()) as { code?: string; error?: string };
    expect(stopped.status, JSON.stringify(body)).toBe(402);
    expect(body.code).toBe(MEMBER_LIMIT_REACHED);
    expect(sent).toHaveLength(0);

    const refused = gateway.filter((call) => call.code === MEMBER_LIMIT_REACHED);
    expect(refused.length).toBeGreaterThan(0);
    const reservedJob = refused[0].job;
    expect(new Set(refused.map((call) => call.job)).size).toBe(1);

    const first = await ask(binding, 'm-stopped', { kind: 'job' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // A second press is the same ask.
    expect((await ask(binding, 'm-stopped', { kind: 'job' })).status).toBe(200);

    const held = (await asksHeld()).requests;
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: 'job', state: 'pending', jobId: reservedJob });
    expect(reservedJob).toMatch(/^model-.*\.t[0-9a-f]{24}$/);
  });

  /** The conversation run a thread's message ran on, and the turn step it recorded for the command. */
  const turnStepOf = async (binding: Binding, commandId: string) => {
    const state = await api<{ conversations: { id: string; lineages?: { runId: string }[] }[] }>(`/projects/${binding.projectId}/state`);
    const runId = state.conversations.find((thread) => thread.id === binding.threadId)!.lineages!.at(-1)!.runId;
    const run = await (app.locals.harness as { modelSessions: { get(projectId: string, runId: string): Promise<{ steps: { intent: { stepId: string }; state: string }[] }> } })
      .modelSessions.get(binding.projectId, runId);
    return { runId, step: run.steps.find((item) => item.intent.stepId === `turn:${digest(commandId).slice(0, 40)}`) };
  };

  test('the refused turn leaves an unfinished step on the conversation run, and locate still finds it', async () => {
    const binding = await priyaHome();
    await limitPriya(100);
    expect((await say(binding, 'm-failed', 'How many loaves are on order?')).status).toBe(402);
    const { runId, step } = await turnStepOf(binding, 'm-failed');
    // The refusal is the person's to lift, so the turn waits to be retried rather than closing as failed.
    // Either way it never succeeded, and locate reads the step whatever its state.
    expect(step?.state).toBe('retry_wait');
    const reservedJob = gateway.find((call) => call.code === MEMBER_LIMIT_REACHED)!.job;
    // The job the gateway refused is this run's turn for this command, and the ask names exactly it.
    expect(reservedJob).toBe(turnRunId(runId, 'm-failed'));
    expect((await ask(binding, 'm-failed', { kind: 'job' })).status).toBe(200);
    expect((await asksHeld()).requests.map((row) => row.jobId)).toEqual([reservedJob]);
  });

  test('a stop after an answered message names its own job, not the earlier one', async () => {
    const binding = await priyaHome();
    expect((await say(binding, 'm-answered', 'How many loaves are on order?')).status).toBe(200);
    await limitPriya(100);
    expect((await say(binding, 'm-later', 'And rolls?')).status).toBe(402);
    const answeredJob = gateway.find((call) => call.status === 200)!.job;
    const refusedJob = gateway.find((call) => call.code === MEMBER_LIMIT_REACHED)!.job;
    expect(refusedJob).not.toBe(answeredJob);
    expect((await ask(binding, 'm-later', { kind: 'job' })).status).toBe(200);
    expect((await asksHeld()).requests.map((row) => row.jobId)).toEqual([refusedJob]);
  });

  test('a message the project never ran is not found, and nothing is asked', async () => {
    const binding = await priyaHome();
    expect((await ask(binding, 'm-never', { kind: 'job' })).status).toBe(404);
    expect((await asksHeld()).requests).toHaveLength(0);
  });
});
