/**
 * DIO-216 slice B: the local model as an Agent Team member. The Agent Team host
 * (`server/agent-team-host.ts`) admits a member on the local model while the person keeps its
 * profile running, refuses it in the runtime's own words when not, and never starts it. The roster
 * takes a local member only when the person adds one with a profile, and the mailbox Team never
 * chooses or wakes one on its own. One Agent Team start runs a Sol lead on Azure, the local member
 * and a Kimi K3 helper profile on AWS. Fixtures only (`tests/fixtures/three-model-team.ts`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { BONSAI_CONNECTION } from '../server/engines/bonsai.js';
import { EngineService } from '../server/engines/service.js';
import {
  LOCAL_MODEL_NOT_INSTALLED,
  LOCAL_MODEL_NOT_RUNNING,
  LOCAL_MODEL_UNKNOWN_PROFILE,
  localModelOtherProfile,
} from '../server/bonsai/runtime.js';
import { currentAuthority } from '../server/trust/index.js';
import { LOCAL_PROFILE_REFUSED } from '../server/agent-team-host.js';
import type { CollaborationOptions } from '../server/harness/agent-collaboration.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import { BONSAI_ACCOUNT, BONSAI_PROFILES } from '../shared/bonsai.js';
import type { LoopRunInput } from '../shared/native-loop.js';
import { resolveTeamMemberModel } from '../shared/team-routes.js';
import type { TeamMember } from '../shared/types.js';
import { collaborationOfferLabel } from '../client/console/loop-start-model.js';
import {
  addTeam, connectTeamRoutes, DELIVERY, fixtureGate, fixtureTrust, HELPER_ANSWER, K3, localHost, MEMBER_ANSWER,
  ORDER, SOL, SOURCES, teamFixture, teamTransport, type TeamFixture,
} from './fixtures/three-model-team.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, url: string, projectId: string, taskId: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined, service: EngineService;
let fixture: TeamFixture;
let azureConnection: string, awsConnection: { id: string };
let lead: TeamMember, member: TeamMember, helperProfileId: string;
const store = (): Store => app.locals.store;
const harness = (): HarnessHost => app.locals.harness;

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) as T };
}
async function ok<T = any>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request<T>(route, method, body);
  expect(response.status, `${method} ${route}: ${response.text}`).toBe(200);
  return response.data;
}

/** Azure on Sol and AWS on K3 with a route check, both shared with the local model; the local model set up or not. */
async function setUp(options: { configured?: boolean; team?: boolean } = {}) {
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  service.agentGate = fixtureGate;
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    verificationReviewer: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: teamTransport(fixture),
    bonsai: { host: localHost(fixture), configured: options.configured ?? true },
    harnessAuthority: (claim) => currentAuthority(claim, fixtureTrust),
    automationTickMs: null,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await ok<{ id: string }>('/projects', 'POST', { name: 'Linen orders' })).id;
  const folder = store().state(projectId).project.folder;
  await fs.writeFile(path.join(folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(folder, 'delivery.md'), DELIVERY);
  taskId = (await ok<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the linen delivery' })).id;
  ({ azureConnection, awsConnection } = await connectTeamRoutes(ok, path.join(root, 'data'), projectId));
  if (options.team === false) return;
  ({ lead, member, helperProfileId } = await addTeam(ok, projectId));
  fixture.memberSlotId = member.slotId;
}

const options = () => ok<CollaborationOptions>(`/projects/${projectId}/loop/collaboration-options?taskId=${taskId}`);
const memberRow = async () => (await options()).members.find((row) => row.slotId === member.slotId);
const holds = (connectionId: string) => service.modelApi!.exposure.list(connectionId);
/** The local model's status was read, and nothing ever asked it to start. */
function neverStarted() {
  expect(fixture.inspects).toBeGreaterThan(0);
  expect(fixture.acquires.filter((options) => options?.start)).toEqual([]);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio216-team-host-'));
  fixture = teamFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    const closing = server;
    server = undefined;
    try { await app.locals.close(); }
    finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the Agent Team host admits a member on the local model only while its profile runs', () => {
  test('a running profile is admitted, named by its profile, and is never started', async () => {
    await setUp();
    const offered = await options();
    expect(offered.reason).toBeUndefined();
    const leadRow = offered.leads.find((row) => row.slotId === lead.slotId)!;
    expect(leadRow).toMatchObject({ route: 'azure-openai', model: SOL, admitted: true, reason: null });
    const row = offered.members.find((item) => item.slotId === member.slotId)!;
    expect(row).toEqual({ slotId: member.slotId, name: 'Counter', route: 'bonsai', model: 'bonsai-gaming',
      modelName: 'Bonsai Gaming', admitted: true, reason: null });
    // The dialog names the member by its profile, and a cloud model by its id, as before.
    expect(collaborationOfferLabel(row)).toBe('Counter · Bonsai Gaming');
    expect(collaborationOfferLabel(leadRow)).toBe(`Planner · ${SOL}`);
    expect(offered.helpers.find((item) => item.profileId === helperProfileId))
      .toMatchObject({ route: 'aws-bedrock', model: K3, admitted: true, reason: null });
    expect(fixture.calls).toEqual([]);
    expect(fixture.acquires).toEqual([]);
    neverStarted();
  });

  test.each([
    ['is not running', (value: TeamFixture) => { value.running = null; }, LOCAL_MODEL_NOT_RUNNING],
    ['runs Full when the member is on Gaming', (value: TeamFixture) => { value.running = 'Full'; }, localModelOtherProfile('Full', 'Gaming')],
    ['reports itself missing', (value: TeamFixture) => { value.installed = false; }, LOCAL_MODEL_NOT_INSTALLED],
  ])('a local model that %s refuses the member in the runtime’s own words', async (_case, arrange, sentence) => {
    await setUp();
    arrange(fixture);
    expect(await memberRow()).toMatchObject({ route: 'bonsai', model: 'bonsai-gaming', admitted: false, reason: sentence });
    // A start that names the member anyway is refused with the same sentence, and nothing runs.
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId: 'refused-member', taskId, goal: 'Say what is short.', route: 'azure-openai',
      sources: SOURCES, consent: true, composition: true,
      persistentTeam: { leadSlotId: lead.slotId, memberSlotId: member.slotId },
    });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe(sentence);
    expect(await harness().list(projectId)).toEqual([]);
    expect(fixture.calls).toEqual([]);
    for (const connection of [azureConnection, awsConnection.id, BONSAI_CONNECTION]) expect(holds(connection)).toEqual([]);
    expect(fixture.acquires).toEqual([]);
    neverStarted();
  });

  test('a saved profile on the local model is refused plainly: saved profiles do not run there yet', async () => {
    await setUp();
    const saved = await ok<{ profileId: string }>('/agent-profiles', 'POST',
      { name: 'Local checker', engine: 'bonsai', model: 'bonsai-gaming', effort: 'medium', agentId: 'auto', rules: [] });
    expect((await options()).helpers.find((row) => row.profileId === saved.profileId)).toMatchObject({
      route: 'bonsai', model: 'bonsai-gaming', modelName: 'Bonsai Gaming', admitted: false, reason: LOCAL_PROFILE_REFUSED,
    });
    expect(fixture.acquires).toEqual([]);
  });

  test('a local member keeps medium reasoning, as every member does', async () => {
    await setUp();
    await ok(`/projects/${projectId}/threads/${member.threadId}`, 'PUT',
      { engine: 'bonsai', requested: { model: 'bonsai-gaming', effort: 'xhigh' } });
    expect(await memberRow()).toMatchObject({ admitted: false, reason: 'The selected Team member must use medium reasoning.' });
  });
});

describe('only the person puts the local model on the Team', () => {
  test('the roster takes a local member only with a profile; other routes keep their own check', async () => {
    await setUp({ team: false });
    const add = (body: Record<string, unknown>) => request(`/projects/${projectId}/team/members`, 'POST', { role: 'member', ...body });
    for (const model of ['gpt-5.6-sol', undefined]) {
      const refused = await add({ name: 'Counter', engine: 'bonsai', ...(model ? { model } : {}) });
      expect(refused.status).toBe(400);
      expect(refused.data.error).toBe(LOCAL_MODEL_UNKNOWN_PROFILE);
    }
    const full = await add({ name: 'Reader', engine: 'bonsai', model: 'bonsai-full' });
    expect(full.status, full.text).toBe(200);
    expect(full.data.member).toMatchObject({ engine: 'bonsai', model: 'bonsai-full', selection: { by: 'person' } });
    // A provider route still takes any model name up to 200 characters, as before.
    const cloud = await add({ name: 'Writer', engine: 'azure-openai', model: 'any-deployment-name' });
    expect(cloud.status, cloud.text).toBe(200);

    const routes = await ok<{ routes: { route: string }[] }>(`/projects/${projectId}/team/routes`);
    expect(routes.routes.find((item) => item.route === 'bonsai')).toEqual({
      route: 'bonsai', name: 'Bonsai (local)', ready: true, savedModel: null,
      models: BONSAI_PROFILES.map((profile) => ({ slug: profile.slug, name: profile.name })),
    });
    expect(fixture.acquires).toEqual([]);
  });

  test('a computer without the local model lists the route as not ready, with the reason', async () => {
    await setUp({ configured: false, team: false });
    const routes = await ok<{ routes: { route: string }[] }>(`/projects/${projectId}/team/routes`);
    expect(routes.routes.find((item) => item.route === 'bonsai')).toMatchObject({ ready: false, models: [], reason: LOCAL_MODEL_NOT_INSTALLED });
  });

  test('“Nectovia chooses” never picks the local model, even when it is the only route offered', () => {
    const local = { route: 'bonsai' as const, models: BONSAI_PROFILES, savedModel: 'bonsai-gaming', routeDefaultAllowed: false };
    for (const role of ['lead', 'member'] as const)
      expect(resolveTeamMemberModel({ role, style: 'efficient', candidates: [local] })).toMatchObject({ outcome: 'ask' });
  });

  test('mail never wakes a local member into a run; it waits for the person’s own Wake', async () => {
    await setUp();
    // A member whose thread may run tasks would wake on mail. The local member does not.
    await ok(`/projects/${projectId}/threads/${member.threadId}`, 'PUT', { permission: 'task' });
    await ok(`/projects/${projectId}/team/messages`, 'POST', { to: member.slotId, content: 'Count the napkins in delivery.md.' });
    const team = await ok<{ members: TeamMember[] }>(`/projects/${projectId}/team`);
    expect(team.members.find((item) => item.slotId === member.slotId)).toMatchObject({ status: 'waiting', unread: 1 });
    expect(store().state(projectId).sessions).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect(fixture.acquires).toEqual([]);
  });
});

describe('an Agent Team start: Sol leads on Azure, the local model answers as the member, K3 helps on AWS', () => {
  test('each role runs on its own route, the local member holds nothing, and nothing starts the local model', async () => {
    await setUp();
    const started = await ok<{ runId: string }>(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId: 'three-model-team', taskId, goal: 'Compare the delivery with the order and report what is short.',
      route: 'azure-openai', sources: SOURCES, consent: true, composition: true,
      persistentTeam: { leadSlotId: lead.slotId, memberSlotId: member.slotId },
      team: { scope: SOURCES, worker: { profileId: helperProfileId }, advisor: null },
    });
    // The admitted composition binds the member to the local profile, its account and medium reasoning.
    const admitted = (await harness().runs.get(started.runId)).input as unknown as LoopRunInput;
    expect(admitted.collaboration?.persistentTeam?.member).toMatchObject({
      slotId: member.slotId, route: 'bonsai', model: 'bonsai-gaming', accountRoute: BONSAI_ACCOUNT, effort: 'medium',
    });
    expect(admitted.collaboration?.helper).toMatchObject({ route: 'aws-bedrock', model: K3 });

    // The lead proposes its report for the person's approval once both roles answered.
    await vi.waitFor(() => {
      expect(store().state(projectId).needs.some((need) => need.state === 'open' && need.approval),
        JSON.stringify(fixture.leadOutputs)).toBe(true);
    }, { timeout: 30_000, interval: 100 });

    expect([...new Set(fixture.calls.map((call) => call.route))].sort()).toEqual(['aws-bedrock', 'azure-openai', 'bonsai']);
    const local = fixture.calls.filter((call) => call.route === 'bonsai' && call.url.endsWith('/v1/chat/completions'));
    expect(local).toHaveLength(1);
    expect(JSON.stringify(local[0].body)).toContain('Six napkins short.');
    const helper = fixture.calls.filter((call) => call.route === 'aws-bedrock');
    expect(helper).toHaveLength(1);
    expect(helper[0].body).toMatchObject({ model: K3 });
    // The member's answer reached the lead through the owned Team exchange, and so did the helper's.
    const exchange = store().state(projectId).team!.runs.find((run) => 'grant' in run) as { result?: { text: string } } | undefined;
    expect(exchange?.result).toMatchObject({ text: MEMBER_ANSWER });
    expect(JSON.stringify(fixture.leadOutputs)).toContain(MEMBER_ANSWER);
    expect(JSON.stringify(fixture.leadOutputs)).toContain(HELPER_ANSWER);

    // Spend is held only on the two cloud connections. The local member held nothing.
    expect(holds(azureConnection).length).toBeGreaterThan(0);
    expect(holds(awsConnection.id)).toHaveLength(1);
    expect(holds(BONSAI_CONNECTION)).toEqual([]);
    neverStarted();
    expect(fixture.acquires).toEqual([{ start: false }]);
  });
});
