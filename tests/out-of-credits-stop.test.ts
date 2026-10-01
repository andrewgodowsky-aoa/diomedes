/**
 * Out of credits: managed Nectovia work stops where the credits run out, and says so.
 *
 * Owner decision (Andrew, 2026-10-01): a business cannot use more bought credits than it had
 * left, so the work just ends mid task and tells the person usage is out and more must be
 * bought. This file drives every path that can meet the gateway's `insufficient_allowance` or
 * `no_period` refusal through the real app over the faux account service, with the managed
 * gateway answering the refusal on the Nth call:
 *
 * - an Agent conversation turn, including one whose earlier steps already ran;
 * - a Work loop, whose earlier steps stay on its record;
 * - a one-call Work text turn and a team member's Work turn (reachable only when a test
 *   forces them on, because nothing switches Nectovia on for them in Settings).
 *
 * For each: the person reads one role-aware sentence, the refused step is recorded as failed
 * rather than parked for reconciliation, nothing is retried, and the hold was released.
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
import { teamToolRegistry } from '../server/team/tools';
import { MANAGED_LUNA } from '../shared/model-api.js';
import { loopOutcome, loopView } from '../shared/native-loop.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import type { AccountStateView } from '../shared/accounts';
import type { Project } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const OWNER_WORDS =
  'Your business is out of credits, so this stopped here. Buy more credits in Settings, Usage.';
const MEMBER_WORDS =
  'Your business is out of credits, so this stopped here. An owner or admin can buy more credits to keep going.';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const MODEL = MANAGED_LUNA.model;
type Item = Record<string, unknown>;

let root: string;
let cloud: FauxCloud;
let juniper: string;
let engines: EngineService;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
/** Every call the managed gateway received, in order. */
let gatewayBodies: Item[];
/** The gateway call number (1-based) from which it answers "out of credits". Null: never. */
let outFrom: number | null;
let outCode: string;
/** Which answerer serves the calls before the refusal: a scripted one with a tool step, or the faux service. */
let answerer: 'scripted' | 'faux';

const wantsFiles = (body: Item) => {
  const input = (body.input as Item[]) ?? [];
  return JSON.stringify(input).includes('Check the attached files') && !input.some((item) => item.type === 'function_call_output');
};
function scripted(request: Request, body: Item, n: number): Response {
  return sseResponse(
    responsesEvents({
      id: `resp_gw_${n}`,
      object: 'response',
      created_at: 1_790_000_000,
      model: String(body.model),
      status: 'completed',
      output: [
        wantsFiles(body)
          ? { type: 'function_call', id: `fc_gw_${n}`, call_id: `call_list_${n}`, name: 'list_sources', arguments: '{}', status: 'completed' }
          : {
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
  const copy = request.clone();
  const body = (await copy.json()) as Item;
  gatewayBodies.push(body);
  const n = gatewayBodies.length;
  if (outFrom !== null && n >= outFrom)
    return new Response(JSON.stringify({ error: { code: outCode, message: 'Gateway words about this month.' } }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  return answerer === 'scripted' ? scripted(request, body, n) : cloud.handle(request);
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
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-out-of-credits-'));
  gatewayBodies = [];
  outFrom = null;
  outCode = 'insufficient_allowance';
  answerer = 'scripted';
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (req) =>
      new URL(req.url).pathname.startsWith('/managed/v1/') ? gateway(req) : cloud.handle(req),
    ),
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
const PEOPLE: Record<Role, { email: string; words: string }> = {
  owner: { email: DEMO_ACCOUNTS.owner.email, words: OWNER_WORDS },
  admin: { email: DEMO_ACCOUNTS.manager.email, words: OWNER_WORDS },
  member: { email: DEMO_ACCOUNTS.employee.email, words: MEMBER_WORDS },
};
const ROLES = Object.keys(PEOPLE) as Role[];

type Binding = { projectId: string; threadId: string };
/** Home, linked to Juniper by its owner, then read by the person under test. */
async function homeFor(role: Role): Promise<Binding> {
  await signIn(DEMO_ACCOUNTS.owner.email);
  const binding = await api<Binding>('/home/conversation', 'POST');
  await api(`/workspace/organizations/${juniper}/output`, 'POST', { projectId: binding.projectId });
  await signIn(PEOPLE[role].email);
  return binding;
}

/** A project its owner linked to Juniper and allowed to share with Nectovia. */
async function linkedProject(name: string): Promise<string> {
  await signIn(DEMO_ACCOUNTS.owner.email);
  const made = await api<Project>('/projects', 'POST', { name });
  await api(`/workspace/organizations/${juniper}/output`, 'POST', { projectId: made.id });
  const policy = await api<{ version: number }>(`/projects/${made.id}/cloud-sharing`);
  await api(`/projects/${made.id}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version, routes: ['nectovia'], documents: [], shareConversationHistory: false, shareReviewPackets: false,
  });
  return made.id;
}
const say = (binding: Binding, commandId: string, text: string) =>
  request(`/projects/${binding.projectId}/threads/${binding.threadId}/messages`, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });

type RunRecord = { id: string; state: string; failure: unknown; steps: { intent: { stepId: string }; state: string; output?: unknown }[] };
async function runsOf(projectId: string): Promise<RunRecord[]> {
  const dir = path.join(root, 'data', 'projects', projectId, 'harness', 'runs');
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as RunRecord));
}
const stepStates = (run: RunRecord) => run.steps.map((step) => `${step.intent.stepId}:${step.state}`);
async function holdStates(): Promise<string[]> {
  const dir = path.join(root, 'data', 'spend-exposure');
  const files = (await fs.readdir(dir)).filter((name) => name.startsWith('nectovia-'));
  expect(files).toHaveLength(1);
  const ledger = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8')) as { reservations: { state: string }[] };
  return ledger.reservations.map((hold) => hold.state);
}
const PLAIN = (words: string) => {
  expect(words).not.toMatch(/[—–]/);
  expect(words).not.toMatch(/\$|dollar|USD/i);
  expect(words).not.toMatch(/AWS|Bedrock|OpenAI|GPT|Luna|model|provider/i);
};

describe('an Agent conversation turn that meets the end of the credits', () => {
  test.each(ROLES)('%s: the earlier steps stay, the turn ends at the refused step with one sentence, and nothing is retried', async (role) => {
    const binding = await homeFor(role);
    outFrom = 2;
    const sent = await say(binding, 'm-mid', 'Check the attached files, then tell me the loaves on order.');
    const body = (await sent.json()) as { error: string; code: string };
    expect(sent.status).toBe(409);
    expect(body).toEqual({ code: 'ROUTE_REFUSED', error: PEOPLE[role].words });
    PLAIN(body.error);
    // The listing call answered and was charged; the second call was the one refused.
    expect(gatewayBodies).toHaveLength(2);
    // The turn's own run: the steps before the refusal are kept, the refused step failed, none parked.
    const turn = (await runsOf(binding.projectId)).find((run) => run.id.includes('.t'))!;
    expect(stepStates(turn)).toEqual(['context:0:succeeded', 'model:0:succeeded', 'tool:0:succeeded', 'context:1:succeeded', 'model:1:failed']);
    expect(turn.state).toBe('failed');
    expect(await holdStates()).toEqual(['settled', 'released']);
    // No retry loop and nothing resumes later.
    await settle();
    expect(gatewayBodies).toHaveLength(2);
    expect((await runsOf(binding.projectId)).some((run) => run.state === 'reconcile_required')).toBe(false);
  });

  test('the first call refused: nothing ran, the same sentence, one call', async () => {
    const binding = await homeFor('owner');
    outFrom = 1;
    const sent = await say(binding, 'm-first', 'How many loaves are on order?');
    expect(sent.status).toBe(409);
    expect(await sent.json()).toEqual({ code: 'ROUTE_REFUSED', error: OWNER_WORDS });
    await settle();
    expect(gatewayBodies).toHaveLength(1);
    expect(await holdStates()).toEqual(['released']);
  });

  test('a business with no credit period yet reads the same sentence, and the code is kept', async () => {
    const binding = await homeFor('member');
    outFrom = 1;
    outCode = 'no_period';
    const sent = await say(binding, 'm-no-period', 'How many loaves are on order?');
    expect(sent.status).toBe(409);
    expect(await sent.json()).toEqual({ code: 'ROUTE_REFUSED', error: MEMBER_WORDS });
    const turn = (await runsOf(binding.projectId)).find((run) => run.id.includes('.t'))!;
    expect(turn.steps.map((step) => step.state)).not.toContain('reconcile_required');
    expect(turn.steps.find((step) => step.intent.stepId === 'model:0')).toMatchObject({ state: 'failed' });
    expect(turn.steps.find((step) => step.intent.stepId === 'model:0')).toMatchObject({ error: { name: 'ModelApiError' } });
  });

  test('credits bought afterwards let the next message through; the refused message is not replayed', async () => {
    const binding = await homeFor('owner');
    outFrom = 1;
    expect((await say(binding, 'm-out', 'How many loaves are on order?')).status).toBe(409);
    expect(gatewayBodies).toHaveLength(1);
    outFrom = null;
    const next = await say(binding, 'm-after', 'And rolls?');
    expect(next.status, await next.clone().text()).toBe(200);
    // One call for the new message, none re-sent for the refused one.
    expect(gatewayBodies).toHaveLength(2);
  });
});

describe('a Work loop that meets the end of the credits', () => {
  async function project() {
    const made = await linkedProject('Juniper loop');
    const taskId = (await api<{ id: string }>(`/projects/${made}/tasks`, 'POST', { name: 'Check the order' })).id;
    return { projectId: made, taskId };
  }
  const start = (projectId: string, taskId: string, commandId: string) =>
    request(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId, taskId, goal: 'Read the order and report the count.', route: 'nectovia', consent: true, sources: [],
    });

  test.each(ROLES)('%s: the run ends at the refused step, keeps what it did, and the Work record says why', async (role) => {
    answerer = 'faux';
    const { projectId, taskId } = await project();
    await signIn(PEOPLE[role].email);
    // The plan is answered; the first act call is refused.
    outFrom = 2;
    const commandId = `out-of-credits-${role}`;
    const started = await start(projectId, taskId, commandId);
    expect(started.status, await started.clone().text()).toBe(200);
    const runId = loopRunId(projectId, commandId);
    await vi.waitFor(async () => expect(['cancelled', 'failed', 'reconcile_required', 'completed']).toContain((await app.locals.harness.get(projectId, runId)).state), { timeout: 20_000 });
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
      'stop:credits:succeeded',
    ]);
    // The record, the outcome and the session line all carry the one sentence.
    const view = loopView(run);
    expect(view.stop).toMatchObject({ reason: 'credits', detail: PEOPLE[role].words });
    expect(loopOutcome(view, null)).toEqual({ state: 'stopped-limit', label: 'Stopped: out of credits', sentence: PEOPLE[role].words });
    const session = app.locals.store.state(projectId).sessions.find((item: { taskId: string }) => item.taskId === taskId)!;
    expect(session.state).toBe('stopped');
    const plain = session.log.filter((entry: { level: string }) => entry.level === 'plain').map((entry: { sentence: string }) => entry.sentence);
    expect(plain.at(-1)).toBe(PEOPLE[role].words);
    PLAIN(PEOPLE[role].words);
    // Plan call answered, act call refused, and nothing was sent again.
    expect(gatewayBodies).toHaveLength(2);
    await settle();
    expect(gatewayBodies).toHaveLength(2);
    expect(await holdStates()).toEqual(['settled', 'released']);
  });
});

describe('a Work text turn and a team member turn that meet the end of the credits', () => {
  const input = (requestId: string, projectId: string) => ({
    projectId,
    threadId: `thread-${requestId}`,
    requestId,
    prompt: 'Report the count.',
    documents: [],
    instructions: 'Be brief.',
    model: MODEL,
    accountRoute: `nectovia:${juniper}`,
  });

  test('the one-call text turn is refused in plain words, its record is failed not parked, and a replay sends nothing', async () => {
    const projectId = await linkedProject('Juniper work');
    // Nothing switches Nectovia on for this route: the test does, to reach it.
    const store = app.locals.store;
    await store.locked(() =>
      store.saveSettings({ ...store.settings, services: { ...store.settings.services, nectovia: true, nectoviaAccountRoute: `nectovia:${juniper}` } }),
    );
    outFrom = 1;
    const refused = await engines.generateModelApi('nectovia', input('rq-text', projectId)).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'ROUTE_REFUSED', message: OWNER_WORDS });
    const run = (await runsOf(projectId)).find((item) => item.steps.some((step) => step.intent.stepId === 'text:dispatch'))!;
    expect(stepStates(run)).toEqual(['text:admission:succeeded', 'text:dispatch:failed']);
    expect(run.state).toBe('failed');
    // The same request again answers from its record: it was already decided and is never sent twice.
    const again = await engines.generateModelApi('nectovia', input('rq-text', projectId)).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(Error);
    await settle();
    expect(gatewayBodies).toHaveLength(1);
  });

  test('the team member turn is refused in plain words and its record is failed, not parked', async () => {
    const projectId = await linkedProject('Juniper work');
    outFrom = 1;
    const registry = teamToolRegistry({ projectId, member: { slotId: 'slot-1' } as never, store: app.locals.store, service: {} as never });
    const refused = await engines.generateModelApiTools('nectovia', input('rq-team', projectId), registry).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'ROUTE_REFUSED', message: OWNER_WORDS });
    const run = (await runsOf(projectId)).find((item) => item.steps.some((step) => step.intent.stepId === 'model:0'))!;
    expect(stepStates(run)).toEqual(['context:0:succeeded', 'model:0:failed']);
    expect(run.state).toBe('failed');
    await settle();
    expect(gatewayBodies).toHaveLength(1);
  });
});
