/**
 * The Nectovia bot through the real app over HTTP (bot-mode items 2 to 5).
 *
 * A Business member's Home conversation answers on the `nectovia` route with nothing
 * connected: the call goes to the account service's managed gateway as the signed-in
 * person, under the admission the Agent gate recorded, on the model the service's
 * published policy names for the tier. A Free person, a business without the Agent
 * and a person who is not signed in are refused in plain words before any gateway
 * call. No AWS call is made anywhere in this file.
 *
 * The account service is the real control-plane handler over the faux store, in this
 * process. Its managed gateway is a scripted double on the same transport, so the
 * desktop's own client is what reaches it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { NECTOVIA_SIGN_IN, NECTOVIA_UNAVAILABLE } from '../server/engines/nectovia';
import { testOnlySecretBox } from '../server/connection-secrets';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import { AGENT_PERSONAL_REASON } from '../shared/access';
import type { AccountStateView } from '../shared/accounts';
import type { MessageResult } from '../shared/conversation';
import type { NectoviaRouteView } from '../shared/model-api';
import type { Conversation } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const ACCOUNT_SERVICE = 'http://faux.local';

type Item = Record<string, unknown>;
interface GatewayCall {
  url: string;
  headers: Record<string, string>;
  body: Item;
}

let root: string;
let cloud: FauxCloud;
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let gateway: GatewayCall[];
let awsCalls: number;
/** A scripted refusal the gateway answers with instead of an answer, when set. */
let refuseWith: { status: number; code: string; message: string } | null;

/** The managed gateway double: one streamed answer per call, echoing the attempt it was given. */
/** A message that asks to check the files, before the tool's output has come back. */
const wantsFiles = (body: Item) => {
  const input = (body.input as Item[]) ?? [];
  return (
    JSON.stringify(input).includes('Check the attached files') &&
    !input.some((item) => item.type === 'function_call_output')
  );
};

async function managed(request: Request): Promise<Response> {
  const body = (await request.json()) as Item;
  gateway.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body });
  const n = gateway.length;
  if (refuseWith)
    return new Response(JSON.stringify({ error: { code: refuseWith.code, message: refuseWith.message } }), {
      status: refuseWith.status,
      headers: { 'content-type': 'application/json' },
    });
  return sseResponse(
    responsesEvents({
      id: `resp_gw_${n}`,
      object: 'response',
      created_at: 1_790_000_000,
      model: String(body.model),
      status: 'completed',
      output: [
        // Asked to check the files, the model first lists them; with the tool's output it answers.
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

async function open(accounts: { backend: AccountBackend } | null = { backend }) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: (async () => {
      awsCalls += 1;
      throw new Error('No provider is called directly in this file');
    }) as typeof globalThis.fetch,
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
const signIn = (email: string) =>
  api<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });

type Binding = { projectId: string; threadId: string };
const home = () => api<Binding>('/home/conversation', 'POST');
const homeThread = async (binding: Binding) =>
  (await api<{ conversations: Conversation[] }>(`/projects/${binding.projectId}/state`)).conversations.find(
    (thread) => thread.id === binding.threadId,
  )!;
const say = (binding: Binding, commandId: string, text: string) =>
  request(`/projects/${binding.projectId}/threads/${binding.threadId}/messages`, 'POST', {
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-nectovia-bot-'));
  gateway = [];
  awsCalls = 0;
  refuseWith = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  await seedDemo(cloud);
  // The Routing role qualifies GPT-6 Luna and publishes it for Efficient and Focused. Thorough
  // stays unrouted. (The faux seed alone still names GPT-5.6 Luna for Efficient.)
  const routing = await staffToken(DEMO_ACCOUNTS.staffRouting.email);
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
  await cloud.commercial.publishPolicy(routing, {
    tiers: { efficient: 'aws-luna-6', focused: 'aws-luna-6', thorough: null },
    note: 'Test fixture: GPT-6 Luna for Efficient and Focused.',
    baseRevision: 1,
  });
  backend = {
    client: new ControlPlaneClient(ACCOUNT_SERVICE, (req) =>
      new URL(req.url).pathname.startsWith('/managed/v1/') ? managed(req) : cloud.handle(req),
    ),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  await open();
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('the Nectovia bot', () => {
  test('a Business owner’s Home message answers on nectovia through the managed gateway, with nothing connected', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const organizationId = owner.workspaces[0].organization.id;
    const binding = await home();
    expect(await homeThread(binding)).toMatchObject({ engine: 'nectovia' });

    const view = await api<NectoviaRouteView>('/ai/nectovia');
    expect(view).toMatchObject({
      route: 'nectovia',
      ownerRoutes: false,
      refusal: null,
      policyRevision: 2,
      tiers: {
        efficient: { model: 'us.openai.gpt-6-luna', label: 'GPT-6 Luna' },
        focused: { model: 'us.openai.gpt-6-luna', label: 'GPT-6 Luna' },
        thorough: null,
      },
    });
    // The header reads the published policy's model, not a local tier map.
    const style = await api<{ route: string; resolution: { model: string; effort: string } | null }>(
      `/projects/${binding.projectId}/threads/${binding.threadId}/work-style`,
    );
    expect(style).toMatchObject({ route: 'nectovia', resolution: { model: 'us.openai.gpt-6-luna', effort: 'low' } });

    const sent = await say(binding, 'm-owner', 'How many loaves are on order?');
    const text = await sent.text();
    expect(sent.status, text).toBe(200);
    expect(JSON.parse(text) as MessageResult).toMatchObject({
      answerText: 'Twelve loaves are on order.',
      outcome: { status: 'answered' },
    });

    expect(awsCalls).toBe(0);
    expect(gateway.length).toBeGreaterThan(0);
    for (const call of gateway) {
      expect(call.url).toBe(`${ACCOUNT_SERVICE}/managed/v1/responses`);
      expect(call.headers).toMatchObject({
        authorization: expect.stringMatching(/^Bearer \S{20,}$/),
        'x-nectovia-organization': organizationId,
        'x-nectovia-admission': expect.stringMatching(/^agent_admission/),
        'x-nectovia-job': expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        'x-nectovia-attempt': expect.stringMatching(/^exp-[0-9a-f]{40}$/),
        'x-nectovia-tier': 'efficient',
        'x-nectovia-usage-class': 'included-chat',
        'x-nectovia-policy-revision': '2',
      });
      expect(call.body).toMatchObject({ model: 'us.openai.gpt-6-luna', store: false, reasoning: { effort: 'low' } });
    }
    // The admission the gateway was given is the one the service recorded for this business.
    const billing = await staffToken(DEMO_ACCOUNTS.staffBilling.email);
    const customer = await cloud.commercial.customer(billing, organizationId);
    const admitted = customer.admissions.filter((row) => row.decision === 'admitted');
    expect(admitted.map((row) => row.id)).toContain(gateway[0].headers['x-nectovia-admission']);
    expect(admitted.find((row) => row.id === gateway[0].headers['x-nectovia-admission'])).toMatchObject({
      routeKind: 'managed',
      surface: 'conversation',
    });
  });

  test('each message is its own job: two messages carry two job ids, each the rootJobId its admission names', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const organizationId = owner.workspaces[0].organization.id;
    const binding = await home();
    const results: MessageResult[] = [];
    for (const [commandId, text] of [['m-first', 'How many loaves are on order?'], ['m-second', 'And rolls?']]) {
      const sent = await say(binding, commandId, text);
      expect(sent.status, await sent.clone().text()).toBe(200);
      results.push((await sent.json()) as MessageResult);
    }
    expect(gateway).toHaveLength(2);
    const jobs = gateway.map((call) => call.headers['x-nectovia-job']);
    expect(new Set(jobs).size).toBe(2);
    // Both messages continue one conversation run; each job is that message's own turn run.
    expect(results[1].runId).toBe(results[0].runId);
    for (const job of jobs) {
      expect(job).not.toBe(results[0].runId);
      expect(job.startsWith(`${results[0].runId}.t`)).toBe(true);
    }
    // One managed admission per message, pinned to that message's job.
    const admissions = gateway.map((call) => call.headers['x-nectovia-admission']);
    expect(new Set(admissions).size).toBe(2);
    const billing = await staffToken(DEMO_ACCOUNTS.staffBilling.email);
    const recorded = (await cloud.commercial.customer(billing, organizationId)).admissions;
    for (const call of gateway) {
      const record = recorded.find((row) => row.id === call.headers['x-nectovia-admission']);
      expect(record).toMatchObject({ decision: 'admitted', routeKind: 'managed', rootJobId: call.headers['x-nectovia-job'] });
    }
  });

  test('a message with a tool step sends the same job on both calls, each with its own attempt', async () => {
    await signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await home();
    const sent = await say(binding, 'm-files', 'Check the attached files, then tell me the loaves on order.');
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(((await sent.json()) as MessageResult).answerText).toBe('Twelve loaves are on order.');
    expect(gateway).toHaveLength(2);
    const [asked, continued] = gateway;
    // The second call carries the tool's output: the same message, one step on.
    expect(JSON.stringify(continued.body.input)).toContain('function_call_output');
    expect(continued.headers['x-nectovia-job']).toBe(asked.headers['x-nectovia-job']);
    expect(continued.headers['x-nectovia-admission']).toBe(asked.headers['x-nectovia-admission']);
    expect(continued.headers['x-nectovia-attempt']).not.toBe(asked.headers['x-nectovia-attempt']);
    for (const call of gateway) {
      expect(call.headers['x-nectovia-attempt']).toMatch(/^exp-[0-9a-f]{40}$/);
      // Neither call is a retry, so neither names a parent attempt.
      expect(call.headers).not.toHaveProperty('x-nectovia-parent-attempt');
    }
  });

  test('a tier chosen on the Home thread stays on nectovia: Focused runs the policy’s model at medium, Thorough is refused by name', async () => {
    await signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await home();
    await api(`/projects/${binding.projectId}/threads/${binding.threadId}`, 'PUT', { workStyle: 'focused' });
    expect(await homeThread(binding)).toMatchObject({ engine: 'nectovia', workStyle: 'focused' });
    const answered = await say(binding, 'm-focused', 'How many loaves are on order?');
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect(gateway.at(-1)!.headers['x-nectovia-tier']).toBe('focused');
    expect(gateway.at(-1)!.body).toMatchObject({ model: 'us.openai.gpt-6-luna', reasoning: { effort: 'medium' } });

    const before = gateway.length;
    await api(`/projects/${binding.projectId}/threads/${binding.threadId}`, 'PUT', { workStyle: 'thorough' });
    const refused = await say(binding, 'm-thorough', 'Plan next week.');
    const body = (await refused.json()) as { error: string };
    expect(refused.status).toBe(409);
    expect(body.error).toBe('Thorough has no Nectovia model right now. Nothing was sent. Choose another tier.');
    expect(gateway.length).toBe(before);
    expect(awsCalls).toBe(0);
    expect(await homeThread(binding)).toMatchObject({ engine: 'nectovia' });
  });

  test.each([
    [402, 'insufficient_allowance', "This business has used this month's 1,000 credits.", "This business has used this month's 1,000 credits."],
    [503, 'route_unavailable', 'Upstream route is down.', NECTOVIA_UNAVAILABLE],
    [429, 'provider_busy', 'Slow down.', "Nectovia's model service is busy. Nothing was charged. Try again in a minute."],
  ])('a gateway %i %s reaches the conversation in plain words, with the local hold released', async (status, code, said, words) => {
    await signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await home();
    refuseWith = { status, code, message: said };
    const refused = await say(binding, `m-${code}`, 'How many loaves are on order?');
    const body = (await refused.json()) as { error: string; code: string };
    expect(refused.status).toBe(409);
    expect(body).toMatchObject({ code: 'ROUTE_REFUSED', error: words });
    expect(body.error).not.toMatch(/AWS|Bedrock|connect/i);
    // One call, no retry under the SDK, and nothing sent anywhere else.
    expect(gateway).toHaveLength(1);
    expect(awsCalls).toBe(0);
    // The local guard released its hold: a refusal is known not to have been charged.
    const ledgers = (await fs.readdir(path.join(root, 'data', 'spend-exposure'))).filter((name) => name.startsWith('nectovia-'));
    expect(ledgers).toHaveLength(1);
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'data', 'spend-exposure', ledgers[0]), 'utf8')) as {
      reservations: { state: string }[];
    };
    expect(ledger.reservations.map((hold) => hold.state)).toEqual(['released']);
  });

  test('a Free person is refused with the service’s sentence before any gateway call', async () => {
    await signIn(DEMO_ACCOUNTS.free.email);
    const binding = await home();
    const refused = await say(binding, 'm-free', 'How many loaves are on order?');
    const body = (await refused.json()) as { error: string; code: string };
    expect(refused.status).toBe(403);
    expect(body).toMatchObject({ code: 'AGENT_NOT_INCLUDED', error: AGENT_PERSONAL_REASON });
    expect(gateway).toHaveLength(0);
    expect(awsCalls).toBe(0);
    expect(body.error).not.toMatch(/AWS|Bedrock|provider|connect/i);
  });

  test('a business without the Agent in its plan is refused with the service’s reason before any gateway call', async () => {
    await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const binding = await home();
    const refused = await say(binding, 'm-harbor', 'How many hammers are in stock?');
    const body = (await refused.json()) as { error: string; code: string };
    expect(refused.status).toBe(403);
    expect(body.code).toBe('AGENT_NOT_INCLUDED');
    expect(body.error).not.toMatch(/AWS|Bedrock|provider|connect/i);
    expect(gateway).toHaveLength(0);
  });

  test('signed out, the host refuses before any gateway call', async () => {
    await signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await home();
    await api('/account/sign-out', 'POST');
    const refused = await say(binding, 'm-out', 'How many loaves are on order?');
    expect(refused.status).toBe(401);
    // With accounts on, the host's sign-in guard answers every route first, in its own words; the
    // app's account gate then shows the sign-in.
    expect(await refused.json()).toMatchObject({ code: 'sign_in_required', error: 'Sign in to use Nectovia.' });
    expect(gateway).toHaveLength(0);
  });

  test('a host without accounts says to sign in to use the Agent, before any gateway call', async () => {
    await close();
    await open(null);
    const binding = await home();
    expect(await homeThread(binding)).toMatchObject({ engine: 'nectovia' });
    const refused = await say(binding, 'm-off', 'How many loaves are on order?');
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: 'sign_in_required', error: NECTOVIA_SIGN_IN });
    expect(gateway).toHaveLength(0);
    expect(awsCalls).toBe(0);
  });
});
