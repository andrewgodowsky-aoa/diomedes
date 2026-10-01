import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import { createApp } from '../../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../../server/engines/service.js';
import type { PersistentTextAdapter } from '../../server/engines/contract.js';
import type { ClaudeSessionCheckpoint } from '../../server/engines/claude-session.js';
import { routeContractFor } from '../../server/harness/route-contract.js';
import { hash } from '../../server/store.js';
import { testOnlySecretBox } from '../../server/connection-secrets.js';
import { ControlPlaneClient } from '../../server/accounts/client.js';
import type { AccountBackend } from '../../server/accounts/backend.js';
import { AWS_LUNA_MODEL } from '../../server/engines/aws-bedrock.js';
import { createFauxCloud, FAUX_BACKEND_LABEL } from '../../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../../services/control-plane/src/faux/seed.js';
import type { AccountStateView } from '../../shared/accounts.js';
import type { Conversation } from '../../shared/types.js';
import { responsesEvents, sseResponse } from '../fixtures/model-api-streams.js';

export { DEMO_ACCOUNTS };
export type Binding = { projectId: string; threadId: string };
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const fixtureModel = 'claude-review-fixture';

/** Real account handlers and local HTTP, with only provider transports replaced. */
export async function reviewFixture() {
  const parent = path.join(os.tmpdir(), 'paid-access-lapse');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  const cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  await seedDemo(cloud);
  const calls = { direct: 0, model: 0, account: [] as string[] };
  let offline = false;
  let accessUnavailable = false;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://review-faux.local', async (request) => {
      calls.account.push(`${request.method} ${new URL(request.url).pathname}`);
      if (offline) throw new Error('Account service offline in review fixture');
      if (accessUnavailable && new URL(request.url).pathname.endsWith('/access'))
        return new Response('Account access unavailable in review fixture', { status: 503 });
      return cloud.handle(request);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
    id: 'claude-code', contract: routeContractFor('claude-code'), sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({ authentication: 'signed-in', accountRoute: 'claude-code:claude.ai', detail: 'Review fixture',
      models: [{ slug: fixtureModel, name: fixtureModel, description: '', efforts: [], defaultEffort: null }] }),
    generate: async () => { throw new Error('Review fixture requires the real session driver'); },
    openSession: async (input, options) => {
      let checkpoint: ClaudeSessionCheckpoint = options.restore ? structuredClone(options.restore) : {
        version: 1, nativeSessionId: randomUUID(), lineageId: randomUUID(), parentSessionId: null,
        projectId: input.projectId, threadId: input.threadId, cwd: root, cliVersion: TESTED_VERSIONS['claude-code'],
        accountDigest: hash('review-fixture-account')!, requestedModel: input.model, reportedModel: null,
        instructionDigest: hash(input.instructions)!, state: 'idle', requests: [], results: [],
      };
      return {
        get checkpoint() { return structuredClone(checkpoint); },
        get nativeSession() { return checkpoint.nativeSessionId ? {
          providerId: 'claude-code', lineageId: checkpoint.lineageId, opaqueRef: checkpoint.nativeSessionId,
        } : null; },
        turn: async (turn) => {
          calls.direct += 1;
          checkpoint = { ...checkpoint, state: 'idle', reportedModel: fixtureModel,
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
            results: [...checkpoint.results, { id: turn.requestId, digest: hash('Direct engine answer')! }] };
          await options.onCheckpoint(checkpoint, new AbortController().signal);
          return { text: 'Direct engine answer', model: fixtureModel, version: TESTED_VERSIONS['claude-code'],
            projectId: turn.projectId, threadId: turn.threadId, requestId: turn.requestId };
        },
        interrupt: async () => {}, close: async () => {},
      };
    },
  };
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server | undefined;
  let base = '';
  async function open() {
    const engines = new EngineService(path.join(root, 'engines'), {
      discover: async () => [{ id: 'claude-code', name: 'Review fixture', kind: 'online', found: true, available: false,
        enabled: false, status: 'Installed', detail: 'Review fixture', capabilities: [], signIn: 'unknown',
        adapter: 'planned', installedVersion: TESTED_VERSIONS['claude-code'], location: process.execPath, disclosure: [] }],
      version: async () => TESTED_VERSIONS['claude-code'], adapter: () => adapter,
    });
    app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
      engineService: engines, reviewerAdapter: null, secretBox: testOnlySecretBox(), accounts: { backend, env: {} },
      automationTickMs: null,
      modelApiTransport: (async () => {
        calls.model += 1;
        return sseResponse(responsesEvents({ id: `review-${calls.model}`, object: 'response', created_at: 1_790_000_000,
          model: AWS_LUNA_MODEL, status: 'completed', output: [{ type: 'message', id: `message-${calls.model}`,
            role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Agent answer', annotations: [] }] }],
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 }, incomplete_details: null, error: null }),
          { 'x-amzn-requestid': `review-${calls.model}` });
      }) as typeof fetch,
    });
    server = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function close() {
    if (!server) return;
    const closing = server;
    server = undefined;
    try { await app.locals.close(); } finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
    }
  }
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${base}/api${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(route, method, body);
    const text = await response.text();
    expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
    return (text ? JSON.parse(text) : null) as T;
  }
  const signIn = (email: string, remember = false) => api<AccountStateView>('/account/sign-in', 'POST', {
    email, password: FAUX_DEMO_PASSWORD, remember,
  });
  async function staff() {
    const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, {
      email: DEMO_ACCOUNTS.staffBilling.email, password: FAUX_DEMO_PASSWORD, remember: false,
    }));
    await cloud.accounts.signIn(pair.accessToken);
    return pair.accessToken;
  }
  async function revoke(organizationId: string) {
    const token = await staff();
    const customer = await cloud.commercial.customer(token, organizationId);
    for (const grant of customer.grants.filter((row) => row.state === 'active'))
      await cloud.commercial.revokeGrant(token, organizationId, grant.id, { reason: 'Independent review downgrade' });
  }
  async function regrant(organizationId: string) {
    const token = await staff();
    await cloud.commercial.issueGrant(token, organizationId, { planId: 'business', source: 'internal-test', reference: 'DIO-126 regrant', note: 'Granted again.' });
  }
  // The person's own Individual plan (DIO-128), granted and withdrawn by billing staff.
  const individualGrants = new Map<string, string>();
  async function personIdOf(email: string) {
    const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
    return (await cloud.accounts.signIn(pair.accessToken)).person.id;
  }
  async function grantIndividual(email: string) {
    const personId = await personIdOf(email);
    const { grant } = await cloud.commercial.issuePersonGrant(await staff(), personId,
      { planId: 'individual', source: 'subscription', reference: 'DIO-128 individual', note: '' });
    individualGrants.set(personId, grant.id);
  }
  async function revokeIndividual(email: string) {
    const personId = await personIdOf(email);
    await cloud.commercial.revokePersonGrant(await staff(), personId, individualGrants.get(personId)!, { reason: 'Individual lapse review' });
  }
  async function ownEngine(binding: Binding) {
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: 'claude-code', model: fixtureModel });
    await api(`/projects/${binding.projectId}/cloud-sharing`, 'PUT', {
      expectedVersion: 0, routes: ['claude-code', 'aws-bedrock'], documents: [],
      shareConversationHistory: true, shareReviewPackets: false,
    });
  }
  async function aws(binding: Binding) {
    await api(`/projects/${binding.projectId}/threads/${binding.threadId}`, 'PUT', { engine: 'aws-bedrock' });
    await api('/ai/model-api/aws-bedrock', 'PUT', { accountId: '123456789012', region: 'us-east-1', model: AWS_LUNA_MODEL,
      apiKey: 'test-only-review-key-0123456789abcdef', expiresAt: null, consent: true });
    await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  }
  const say = (binding: Binding, commandId: string) => request(
    `/projects/${binding.projectId}/threads/${binding.threadId}/messages`, 'POST',
    { commandId, text: 'Summarize the order.', mode: 'auto', sources: [], consent: true });
  const home = () => api<Binding>('/home/conversation', 'POST');
  const thread = async (binding: Binding) => (await api<{ conversations: Conversation[] }>(
    `/projects/${binding.projectId}/state`)).conversations.find((item) => item.id === binding.threadId)!;
  await open();
  return { root, cloud, calls, request, api, signIn, staff, revoke, regrant, grantIndividual, revokeIndividual, ownEngine, aws, say, home, thread,
    offline: (value: boolean) => { offline = value; },
    accessUnavailable: (value: boolean) => { accessUnavailable = value; },
    restart: async () => { await close(); await open(); },
    dispose: async () => { await close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}
