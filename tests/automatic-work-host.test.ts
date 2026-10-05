/**
 * Independent normal-entry acceptance through production HTTP, Store, Trust,
 * model-session decision phases, native loop, SDK serialization and spend ledger.
 * The only model fixture is the existing captured provider HTTP stream. No manual
 * decision/admission, selection phase, Team grant, root binding or new harness is seeded.
 * Team cases use the repository's FauxCloud account backend and its public identity-backend
 * contract. Their explicitly synthetic project qualification records are fixture inputs,
 * never evidence that a live model, deployed identity or paid account is qualified.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { openRouterRateCard } from '../server/engines/openrouter.js';
import { conversationCommandIds } from '../server/interaction-admission.js';
import { commandBinding, sourceMessageIdFor } from '../server/interaction-turn.js';
import { jobKeyFor } from '../server/job-caps.js';
import { validateTaskReceipts } from '../server/task-admission.js';
import { loopRunId } from '../server/native-loop-routes.js';
import { turnRunId } from '../server/harness/model-session-run.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { HarnessRun } from '../shared/harness.js';
import type { MessageRequest, MessageResult } from '../shared/conversation.js';
import type { OpenRouterConnectionView } from '../shared/model-api.js';
import type { Conversation, Task, TeamMember, Session, Need } from '../shared/types.js';
import type { AgentProfileRevision } from '../shared/agent-profiles.js';
import { isOwnedTeamRun, type OwnedTeamRun } from '../shared/agent-collaboration.js';
import type { AutomaticTeamQualification } from '../shared/automatic-team.js';
import type { WorkspaceView } from '../shared/workspaces.js';
import { AccountAgentGate } from '../server/accounts/agent-gate.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import { installTrustBackend, currentAuthority, refOf, isDenial, type Principal } from '../server/trust/index.js';
import { __resetRevocationState } from '../server/trust/revocation.js';
import { micro } from '../shared/managed-usage.js';
import { REPORT_PATH } from '../server/harness/approval.js';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';
import { MemoryObservationSink } from '../server/observability/exporter.js';
import type { ObservationOptions, ObservationRuntime } from '../server/observability/runtime.js';
import { traceIdFor, spanIdFor } from '../server/observability/sanitize.js';

const MODEL = 'openai/gpt-6.1-sol';
const OTHER_MODEL = 'z-ai/glm-5.3-flash';
const KEY = 'sk-or-independent-normal-entry-0123456789abcdef-never-real';
const INVENTORY = 'A: expected 10, counted 10.\nB: expected 8, counted 6.\n';
const GOAL = 'Reconcile inventory.txt and prepare the exceptions report.';
const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
// Exact inherited removals from the qualification manifest, applied only to our own child.
const OFFLINE_ENV_REMOVALS = new Set([
  'NECTOVIA_ACCOUNT_SERVICE', 'NECTOVIA_FAUX_BEDROCK_API_KEY', 'NECTOVIA_FAUX_OPENROUTER_API_KEY',
  'CP_TEST_DATABASE_URL', 'CP_ROUTING_TEST_DATABASE_URL', 'CP_TEST_ALLOW_SCHEMA_RESET',
  'CP_APPROVED_ISOLATED_BRANCH', 'CP_TEST_EXPECTED_HOST', 'CP_TEST_BRANCH_ID', 'DATABASE_URL',
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE',
  'AZURE_API_KEY', 'AZURE_RESOURCE_NAME', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY',
  'GOOGLE_VERTEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
  'WORKOS_API_KEY', 'CODEX_HOME', 'CP_EVIDENCE_DIRECTORY', 'PLAYWRIGHT_EXECUTABLE_PATH',
  'TEST_WORKER_INDEX', 'VITEST_WORKER_ID', 'NODE_OPTIONS', 'WRANGLER_SEND_METRICS',
]);
// The Team tests chain real provider calls, Store writes and host restarts. Idle, the first
// one reaches its writer Need in about 3 s; a full suite run has slowed this file 2.6x, which
// left a 12 s wait too little headroom. Each wait still fires before its test timeout.
const TEAM_WAIT = { timeout: 30_000 };
const TEAM_TEST = { timeout: 90_000 };
type Item = Record<string, unknown>;
type Seen = { body: Item; kind: 'conversation' | 'native' | 'team' | 'helper'; sourceMessageId: string | null };
let dir: string, projectId: string, base: string, thread: Conversation;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined, service: EngineService;
let connection: OpenRouterConnectionView['connection'];
let seen: Seen[], holdConversation: boolean;
let held: { release: () => void; signal: AbortSignal | undefined } | undefined;
let heldTeam: { release: () => void; signal: AbortSignal | undefined } | undefined;
let heldNative: { release: () => void; signal: AbortSignal | undefined } | undefined;
let holdNative: boolean;
let observationOptions: ObservationOptions | null;
let childProcess: ChildProcess | undefined;
let accountBackend: AccountBackend | null, faux: FauxCloud | undefined;
let identityAvailable: boolean;
let teamFixture: { lead: TeamMember; worker: TeamMember; leadProfile: AgentProfileRevision & { digest: string };
  workerProfile: AgentProfileRevision & { digest: string }; helper: boolean } | undefined;
let teamResponse: 'normal' | 'hold' | 'drain' | 'try-done';
const store = () => app.locals.store as Store;
const host = () => app.locals.harness as HarnessHost;
const state = () => store().state(projectId);
const messages = () => `/projects/${projectId}/threads/${thread.id}/messages`;
const conversation = () => state().conversations.find(item => item.id === thread.id)!;

// H09's public wire retains sha256:<hex>. Only exact raw-digest protocol pins
// (qualification, collaboration and automatic request) use this fixture bridge.
function rawProfilePin(h09Digest: string): string {
  const matched = /^sha256:([a-f0-9]{64})$/.exec(h09Digest);
  if (!matched) throw new Error('The public H09 profile did not report an exact sha256 digest.');
  return matched[1];
}

function decision(sourceMessageId: string): string {
  return 'I will prepare the requested inventory report.\n\n```diomedes-decision\n' + JSON.stringify({
    source_message_id: sourceMessageId, disposition: 'act', requested_project_id: null,
    operation_class: 'write_internal', source_refs: ['inventory.txt'], target_run_id: null,
    question: null, public_summary: 'Prepare the synthetic inventory exceptions report.',
  }) + '\n```';
}
function stream(text: string, id: string, model = MODEL, tool?: { name: string; arguments: unknown }) {
  const output = model === OTHER_MODEL && teamResponse === 'drain' ? 4_000 : 40;
  return sseResponse(chatEvents({ id, model, provider: model === OTHER_MODEL ? 'Baseten' : 'OpenAI', text,
    ...(tool ? { toolCalls: [{ id: `call-${id}`, name: tool.name, arguments: JSON.stringify(tool.arguments) }] } : {}),
    usage: { prompt_tokens: 700, completion_tokens: output, total_tokens: 700 + output, is_byok: false },
  }), { 'x-request-id': `synthetic-${id}` });
}
const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error(`Unexpected provider destination: ${url}`);
  const body = JSON.parse(String(init?.body)) as Item;
  const serialized = JSON.stringify(body.messages);
  const member = serialized.includes('Answer the selected lead\'s question using only the attached sources.');
  const helper = serialized.includes('You are a worker given one bounded task');
  const expectedModel = member || helper ? OTHER_MODEL : MODEL;
  expect(body.model).toBe(expectedModel);
  expect(body.provider).toMatchObject({ only: [expectedModel === OTHER_MODEL ? 'baseten' : 'openai'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' });
  expect(body.parallel_tool_calls).toBe(false);
  expect(body.stream).toBe(true);
  expect(body.reasoning).toMatchObject({ effort: 'medium' });
  expect(body).not.toHaveProperty('api_keys');
  const sourceMessageId = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]/.exec(JSON.stringify(body.messages))?.[1] ?? null;
  seen.push({ body, kind: sourceMessageId ? 'conversation' : member ? 'team' : helper ? 'helper' : 'native', sourceMessageId });
  const id = `captured-entry-${seen.length}`;
  if (sourceMessageId) {
    if (holdConversation) return new Promise<Response>(resolve => {
      held = { signal: init?.signal ?? undefined, release: () => resolve(stream(decision(sourceMessageId), id)) };
    });
    return stream(decision(sourceMessageId), id);
  }
  const tools = (body.tools ?? []) as unknown[];
  if (member) {
    const names = tools.map(tool => (tool as { function?: { name?: string } }).function?.name).sort();
    expect(names).toEqual(['team_members', 'team_read_messages', 'team_task_list', 'team_task_update']);
    const results = ((body.messages ?? []) as Item[]).filter(item => item.role === 'tool');
    if (teamResponse === 'hold') return new Promise<Response>(resolve => {
      heldTeam = { signal: init?.signal ?? undefined,
        release: () => resolve(stream('inventory.txt: B is short by two units. Late text cannot settle a stopped root.', id, OTHER_MODEL)) };
    });
    if (teamResponse === 'drain') return stream('', id, OTHER_MODEL, { name: 'team_read_messages', arguments: {} });
    if (teamResponse === 'try-done' && !results.length) {
      const record = ownedTeam();
      return stream('', id, OTHER_MODEL, { name: 'team_task_update', arguments: { task_id: record.assignmentTaskId, status: 'completed' } });
    }
    return stream('inventory.txt: B is short by two units.', id, OTHER_MODEL);
  }
  if (helper) return stream('inventory.txt: independently checked B, expected 8 and counted 6.', id, OTHER_MODEL);
  if (holdNative) {
    holdNative = false;
    expect(tools).toHaveLength(0); // The real loop's first planning call.
    return new Promise<Response>(resolve => {
      heldNative = { signal: init?.signal ?? undefined, release: () => resolve(stream(
        '1. Read inventory.txt.\n2. Compare the selected rows.\n3. Prepare the exceptions report.', id)) };
    });
  }
  if (teamFixture && tools.length) {
    const count = ((body.messages ?? []) as Item[]).filter(item => item.role === 'tool').length;
    if (count === 0) return stream('', id, MODEL, { name: 'team_task_create', arguments: {
      subject: 'Check the selected inventory discrepancy', description: 'Use only inventory.txt; return one source-cited answer.', owner: teamFixture.worker.slotId } });
    if (count === 1) return stream('', id, MODEL, { name: 'team_send_message', arguments: {
      to: teamFixture.worker.slotId, message: 'Check the inventory discrepancy and cite inventory.txt.', files: ['inventory.txt'] } });
    if (count === 2 && teamFixture.helper) return stream('', id, MODEL, { name: 'assign_workers', arguments: {
      tasks: [{ task: 'Independently check the count difference in inventory.txt.', files: ['inventory.txt'], turns: 2 }] } });
    if (count === (teamFixture.helper ? 3 : 2)) return stream('', id, MODEL, { name: 'propose_write', arguments: { text: '# Inventory exceptions\n\nB: expected 8; counted 6; short 2. Source: inventory.txt.\n' } });
  }
  return stream(tools.length ? 'The selected source says B is short by two. This finish prose is a claim, not verification.'
    : '1. Read inventory.txt.\n2. Compare the selected rows.\n3. Prepare the exceptions report.', id);
}) as typeof globalThis.fetch;

async function open() {
  service = new EngineService(path.join(dir, 'engines'), { discover: async () => [] });
  app = await createApp({ dataDir: path.join(dir, 'data'), projectRoot: path.join(dir, 'projects'),
    engineService: service, reviewerAdapter: null, secretBox: testOnlySecretBox(), modelApiTransport: transport,
    ownerRoutes: true, accounts: accountBackend ? { backend: accountBackend, env: {} } : null, observation: observationOptions, managedJev: false });
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app, closingServer = server;
  server = undefined;
  try { await closingApp.locals.close(); }
  finally { closingServer.closeAllConnections(); await new Promise<void>((resolve, reject) => closingServer.close(error => error ? reject(error) : resolve())); }
}
async function request<T>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as T };
}
async function api<T>(route: string, method = 'GET', body?: unknown) {
  const result = await request<T>(route, method, body);
  expect(result.status >= 200 && result.status < 300, `${route}: ${result.status} ${JSON.stringify(result.data)}`).toBe(true);
  return result.data;
}
async function message(commandId: string, text = GOAL): Promise<MessageRequest> {
  return { commandId, text, mode: 'auto', sources: [{ path: 'inventory.txt', sha: (await store().readDocument(projectId, 'inventory.txt')).sha! }], consent: true };
}
async function send(input: MessageRequest) { return api<MessageResult>(messages(), 'POST', input); }
function taskFor(commandId: string): Task | undefined {
  return state().tasks.find(item => item.automaticWork?.request.commandId === commandId);
}
async function phases(result: Pick<MessageResult, 'runId' | 'sourceMessageId'>) {
  return service.modelSessions!.phases(projectId, result.runId, result.sourceMessageId);
}
async function finished(commandId: string) {
  const task = taskFor(commandId);
  expect(task, 'the normal message admitted its Task').toBeDefined();
  const root = task!.automaticWork!.rootRunId!;
  await vi.waitFor(async () => expect((await host().get(projectId, root)).state).toBe('completed'), { timeout: 12_000 });
  await host().bridge.flush();
  return host().get(projectId, root);
}
function exposureFor(runIds: readonly string[], commandId?: string) {
  // The real SDK conversation exchange is recorded in its existing per-turn child.
  const exact = new Set([...runIds, ...(commandId ? runIds.filter(id => id.startsWith('model-')).map(id => turnRunId(id, commandId)) : [])]);
  return service.modelApi!.exposure.list(connection!.id).filter(row => exact.has(row.attempt.runId));
}

function ownedTeam(): OwnedTeamRun {
  const record = state().team?.runs.find(isOwnedTeamRun);
  if (!record) throw new Error('No production owned Team record exists.');
  return record;
}

async function waitOwnedChild() {
  await vi.waitFor(() => expect(state().team?.runs.some(isOwnedTeamRun)).toBe(true), TEAM_WAIT);
  const record = ownedTeam();
  await vi.waitFor(async () => expect(await host().get(projectId, record.harnessRunId).catch(() => null)).not.toBeNull(), TEAM_WAIT);
  return record;
}

async function waitWriter(sessionId: string) {
  await vi.waitFor(() => expect(state().needs.some(need => need.sessionId === sessionId && need.state === 'open' && need.approval)).toBe(true), TEAM_WAIT);
  await host().bridge.flush();
  return structuredClone(state().needs.find(need => need.sessionId === sessionId && need.state === 'open' && need.approval)!);
}

async function approveWriter(need: Need) {
  return api(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', {
    protocolVersion: 1, commandId: `approve-${need.id}`, resolution: 'go-ahead',
    proposalDigest: need.approval!.proposalDigest, actionDigest: need.approval!.actionDigest, baseDigest: need.approval!.baseDigest,
  });
}

async function setupPaidTeam(options: { qualified?: boolean; workerBudget?: number; identity?: 'owner' | 'deny'; helper?: boolean;
  observationSink?: MemoryObservationSink; observationOrganization?: 'other'; observationDisabled?: boolean } = {}) {
  await close();
  faux = await createFauxCloud({ file: null, passwordIterations: 1_000, liveBedrockApiKey: null, liveOpenRouterApiKey: null });
  expect(faux.provider).toBe('scripted');
  expect(faux.evaluationProvider).toBe('scripted');
  const seeded = await seedDemo(faux);
  observationOptions = options.observationSink ? {
    sink: options.observationSink, timer: false,
    operator: { mode: options.observationDisabled ? 'off' : 'memory', environment: 'test', companyHost: true,
      internalOrganizations: new Set([options.observationOrganization === 'other' ? 'org_other_fixture' : seeded.organizations!.juniper]),
      pseudonymKey: new Uint8Array(Buffer.from('ab'.repeat(32), 'hex')), customerExport: false, posthog: null },
  } : null;
  accountBackend = {
    client: new ControlPlaneClient('http://faux.local', req => faux!.handle(req)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  await open();
  await api('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
  expect(service.agentGate).toBeInstanceOf(AccountAgentGate);
  projectId = (await api<{ id: string }>('/projects', 'POST', { name: 'Synthetic paid Team entry' })).id;
  await api(`/workspace/organizations/${seeded.organizations!.juniper}/output`, 'POST', { projectId });
  await fs.writeFile(path.join(state().project.folder, 'inventory.txt'), INVENTORY);
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['openrouter'],
    documents: ['inventory.txt'], shareConversationHistory: true, shareReviewPackets: false });
  const binding = await api<{ threadId: string }>(`/projects/${projectId}/conversation`, 'POST', {});
  thread = state().conversations.find(item => item.id === binding.threadId)!;
  const leadProfile = await api<AgentProfileRevision & { digest: string }>('/agent-profiles', 'POST', {
    name: 'Synthetic selected lead', engine: 'openrouter', model: MODEL, effort: 'medium', agentId: 'auto', rules: [],
  });
  const workerProfile = await api<AgentProfileRevision & { digest: string }>('/agent-profiles', 'POST', {
    name: 'Synthetic selected member', engine: 'openrouter', model: OTHER_MODEL, effort: 'medium', agentId: 'auto', rules: [],
  });
  const lead = (await api<{ member: TeamMember }>(`/projects/${projectId}/team/members`, 'POST', {
    name: 'Synthetic lead', role: 'lead', engine: 'openrouter', model: MODEL,
  })).member;
  const worker = (await api<{ member: TeamMember }>(`/projects/${projectId}/team/members`, 'POST', {
    name: 'Synthetic member', role: 'member', engine: 'openrouter', model: OTHER_MODEL,
  })).member;
  // The public profile API deliberately stores model/effort placeholders. The
  // factory must resolve the revision; this test never overwrites those placeholders.
  for (const [member, selected] of [[lead, leadProfile], [worker, workerProfile]] as const)
    await api(`/projects/${projectId}/threads/${member.threadId}`, 'PUT', { requested: { profile: selected.profileId } });
  await api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { engine: 'openrouter', mode: 'auto', workStyle: 'efficient',
    requested: { profile: leadProfile.profileId } });
  const workspace = await api<WorkspaceView>('/workspace');
  const owner: Principal = { kind: 'local-owner', id: workspace.person.id, tenantId: null,
    projectId: null, deviceId: null, sessionId: null, slotId: null };
  identityAvailable = options.identity !== 'deny';
  // Existing backend contract only. The real resolver issues/refuses capabilities
  // and compares generations. This local identity fixture is not deployed identity proof.
  installTrustBackend({ lookupTeamMember: async () => null,
    localOwner: async id => identityAvailable && id === owner.id ? { ...owner } : null,
    lookupPrincipalRef: async ref => identityAvailable && ref.kind === owner.kind && ref.id === owner.id ? { ...owner } : null });
  if (identityAvailable) {
    const authority = await currentAuthority({ via: 'local-owner', ownerId: owner.id });
    if (isDenial(authority)) throw new Error(authority.reason);
    expect(authority.synthetic).toBe(false);
    expect(authority.capabilities.has('egress.send')).toBe(true);
    expect(refOf(authority)).toMatchObject({ kind: 'local-owner', id: workspace.person.id });
  }
  teamFixture = { lead, worker, leadProfile, workerProfile, helper: options.helper === true };
  if (options.qualified) {
    const qualifications: AutomaticTeamQualification[] = [leadProfile, workerProfile].map((selected, index) => {
      const id = `offline-project-qualification-${index}`;
      return { id, evidenceSha: (index === 0 ? 'a' : 'b').repeat(64), scope: 'bounded-work', validUntil: '2099-01-01T00:00:00Z',
        route: 'openrouter', model: selected.model, effort: selected.effort, accountRoute: connection!.accountRoute,
        connectionId: connection!.id, connectionRevision: connection!.revision, payerId: seeded.organizations!.juniper,
        profileDigest: rawProfilePin(selected.digest), benchmark: { id: 'explicitly-synthetic-offline-comparison', accepted: true, independent: true, score: index === 0 ? 90 : 60 },
        bounds: { qualificationId: id, workerMicroUsd: index === 0 ? 250_000 : options.workerBudget ?? 40_000,
          verificationMicroUsd: 50_000, correctionMicroUsd: 50_000, coordinationMicroUsd: 50_000 } };
    });
    // Fixture quality/bounds are input records of the existing project Team store.
    // Selection and all root/grant/child/response records must be produced by the host.
    await store().locked(async () => { state().team!.qualifications = qualifications; await store().persist(state()); });
  }
  return teamFixture;
}

async function startSelectedTeam(commandId: string, taskId: string, extra: Item = {}) {
  const selected = teamFixture!;
  return request<{ runId: string; session: Session; replayed: boolean; code?: string; error?: string }>(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1, commandId, taskId, goal: GOAL, route: 'openrouter', model: MODEL,
    accountRoute: connection!.accountRoute, effort: 'medium', consent: true, maxTurns: 8, sources: ['inventory.txt'],
    persistentTeam: { leadSlotId: selected.lead.slotId, memberSlotId: selected.worker.slotId },
    ...(selected.helper ? { team: { scope: ['inventory.txt'], worker: { profileId: selected.workerProfile.profileId }, advisor: null } } : {}),
    ...extra,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-independent-entry-'));
  seen = []; holdConversation = false; held = undefined; holdNative = false; heldNative = undefined; observationOptions = null;
  accountBackend = null; faux = undefined; heldTeam = undefined; teamFixture = undefined; teamResponse = 'normal'; identityAvailable = false;
  await open();
  projectId = (await api<{ id: string }>('/projects', 'POST', { name: 'Synthetic normal entry' })).id;
  await fs.writeFile(path.join(state().project.folder, 'inventory.txt'), INVENTORY);
  const view = await api<OpenRouterConnectionView>('/ai/model-api/openrouter', 'PUT', {
    apiKey: KEY, expiresAt: null, consent: true,
    models: [MODEL, OTHER_MODEL].map(id => ({ reasoning: { supported: ['low', 'medium', 'high'], source: 'Synthetic SDK fixture declaration; not live qualification' }, id, upstreams: [id === OTHER_MODEL ? 'baseten' : 'openai'],
      rates: { inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadUsdPerMillion: null,
        cacheWriteUsdPerMillion: null, source: 'synthetic declared rates for offline boundary tests' } })),
  });
  connection = view.connection;
  expect(connection).not.toBeNull();
  await api('/ai/model-api/openrouter/spend-limit', 'PUT', { capUsd: 100, consent: true });
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['openrouter'],
    documents: ['inventory.txt'], shareConversationHistory: true, shareReviewPackets: false });
  const binding = await api<{ projectId: string; threadId: string }>(`/projects/${projectId}/conversation`, 'POST', {});
  thread = state().conversations.find(item => item.id === binding.threadId)!;
  expect(thread?.id, 'use the existing provisioned project conversation').toBeDefined();
  await api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { engine: 'openrouter', mode: 'auto',
    requested: { model: MODEL, effort: 'medium' } });
});
afterEach(async () => {
  held?.release();
  heldTeam?.release();
  heldNative?.release();
  if (childProcess && childProcess.exitCode === null) childProcess.kill();
  childProcess = undefined;
  await close();
  installTrustBackend({ localOwner: async () => null, lookupPrincipalRef: async () => null, lookupTeamMember: async () => null });
  __resetRevocationState();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('ordinary automatic request admission and its production root', () => {
  test('an unconnected OpenRouter model is refused by public thread choice without replacing the current selection or sending', async () => {
    const original = structuredClone(conversation());
    expect(original.requested).toEqual({ model: MODEL, effort: 'medium' });
    const refused = await request<{ error: string }>(`/projects/${projectId}/threads/${thread.id}`, 'PUT', {
      engine: 'openrouter', requested: { model: 'openai/not-connected-fixture', effort: 'medium' },
    });
    expect(refused.status).toBe(400);
    expect(refused.data.error.trim().length).toBeGreaterThan(0);
    expect(conversation()).toEqual(original); // Fresh Store lookup, not the pre-PUT thread object.
    expect(seen).toHaveLength(0);
    expect(await host().list(projectId)).toHaveLength(0);
    expect(service.modelApi!.exposure.list(connection!.id)).toHaveLength(0);
    await api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', {
      engine: 'openrouter', requested: original.requested,
    });
    expect(conversation()).toEqual(original);
    expect(seen).toHaveLength(0);
  });

  test('an unsupported OpenRouter reasoning level is refused by public thread choice without replacing the current selection or sending', async () => {
    const original = structuredClone(conversation());
    expect(original.requested).toEqual({ model: MODEL, effort: 'medium' });
    const refused = await request<{ error: string }>(`/projects/${projectId}/threads/${thread.id}`, 'PUT', {
      engine: 'openrouter', requested: { model: MODEL, effort: 'xhigh' },
    });
    expect(refused.status).toBe(400);
    expect(refused.data.error.trim().length).toBeGreaterThan(0);
    expect(conversation()).toEqual(original); // Fresh Store lookup after the refused mutation.
    expect(seen).toHaveLength(0);
    expect(await host().list(projectId)).toHaveLength(0);
    expect(service.modelApi!.exposure.list(connection!.id)).toHaveLength(0);
    await api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', {
      engine: 'openrouter', requested: original.requested,
    });
    expect(conversation()).toEqual(original);
    expect(seen).toHaveLength(0);
  });

  test('a qualifying ordinary request automatically links one Task and root without a human-selection phase', async () => {
    const input = await message('ordinary-explicit-request');
    const result = await send(input);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('started');
    if (result.outcome.status !== 'started') throw new Error('The request did not start.');
    const run = await finished(input.commandId);
    const task = taskFor(input.commandId)!;
    const commands = conversationCommandIds(result.sourceMessageId);
    expect(task.automaticWork).toMatchObject({ policyRevision: 'automatic-work-v1',
      rootRunId: loopRunId(projectId, commands.workCommandId), rootJobId: jobKeyFor(projectId, input.commandId),
      request: { kind: 'explicit-request', threadId: thread.id, commandId: input.commandId,
        sourceMessageId: result.sourceMessageId, sourceProjectId: projectId, targetProjectId: projectId,
        goal: GOAL, sources: input.sources, requestDigest: commandBinding('message', input) } });
    expect(task.origin).toMatchObject({ projectId, threadId: thread.id, runId: result.runId });
    expect(task.creationReceipt!.commandId).toBe(commands.taskCommandId);
    expect(task.sessionIds).toEqual([result.outcome.sessionId]);
    expect(run).toMatchObject({ id: task.automaticWork!.rootRunId, projectId, taskId: task.id,
      sessionId: result.outcome.sessionId, capabilityId: 'diomedes-loop' });
    expect(run.input).toMatchObject({ goal: GOAL, route: 'openrouter', model: MODEL,
      accountRoute: connection!.accountRoute, effort: 'medium', sources: ['inventory.txt'],
      rootJobRequestId: input.commandId, rootJobId: jobKeyFor(projectId, input.commandId) });
    expect(task.automaticWork!.request.executionPin).toEqual({ route: 'openrouter', model: MODEL,
      accountRoute: connection!.accountRoute, effort: 'medium', profile: null });
    const saved = await phases(result);
    expect(saved.some(item => item.phase === 'action-selected')).toBe(false);
    expect(saved.find(item => item.phase === 'decision')!.body).toMatchObject({ automaticWork: task.automaticWork!.request });
    expect(saved.filter(item => item.phase === 'task-receipt')).toHaveLength(1);
    expect(saved.filter(item => item.phase === 'work-receipt')).toHaveLength(1);
    expect(state().tasks).toHaveLength(1);
    expect(state().sessions).toHaveLength(1);
    expect(conversation().turns.filter(turn => turn.role === 'you')).toHaveLength(1);
    expect(conversation().turns.filter(turn => turn.role === 'assistant')).toHaveLength(1);
    expect(state().history.filter(entry => entry.kind === 'tasks-made' && entry.taskId === task.id))
      .toMatchObject([{ actor: 'diomedes', taskId: task.id }]);
    expect(state().history.some(entry => entry.kind === 'task-progress' && entry.taskId === task.id && entry.progress!.runId === run.id)).toBe(true);
    // Actual planning and native SDK exchanges spend through the original request's one ledger.
    const rows = exposureFor([result.runId, run.id], input.commandId);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(row => row.jobId))).toEqual(new Set([jobKeyFor(projectId, input.commandId)]));
    expect(seen.filter(item => item.kind === 'conversation')).toHaveLength(1);
    expect(seen.filter(item => item.kind === 'native')).toHaveLength(2);
    expect(taskFor(input.commandId)!.state).toBe('waiting');
    expect(taskFor(input.commandId)!.state).not.toBe('done');
    expect(state().team?.members ?? []).toHaveLength(0);
    expect(state().team?.runs ?? []).toHaveLength(0);
    expect(taskFor(input.commandId)!.automaticWork!.teamDecision).toMatchObject({ mode: 'single' });
    const selection = taskFor(input.commandId)!.automaticWork!.teamDecision!;
    expect(selection.reason.trim().length).toBeGreaterThan(0);
    expect(selection.reason.toLowerCase()).toContain('qualif');
    // Creation proof is historical: ordinary task edits and transcript pruning retain it.
    const historical = structuredClone(state());
    historical.tasks[0]!.name = 'Renamed after admission';
    historical.tasks[0]!.description = 'Edited after admission';
    historical.conversations = [];
    expect(() => validateTaskReceipts(historical)).not.toThrow();
    for (const tamper of ['actor', 'payload', 'request', 'origin'] as const) {
      const incompatible = structuredClone(historical);
      const savedTask = incompatible.tasks[0]!;
      if (tamper === 'actor') incompatible.history.find(event => event.id === savedTask.creationReceipt!.eventId)!.actor = 'you';
      if (tamper === 'payload') savedTask.creationReceipt = {...savedTask.creationReceipt!, payloadDigest: 'sha256:' + 'f'.repeat(64)};
      if (tamper === 'request') savedTask.automaticWork!.request.goal = 'Write a different file.';
      if (tamper === 'origin') savedTask.origin = {...savedTask.origin!, turnId: 'unrelated-turn'};
      expect(() => validateTaskReceipts(incompatible), tamper).toThrow('incompatible or inconsistent');
    }
  });

  test('concurrent identical messages, subsequent replay and app restart never create a second root or send', async () => {
    const input = await message('same-normal-request');
    const results = await Promise.all([0, 1].map(() => send(input)));
    expect(new Set(results.map(result => result.runId)).size).toBe(1);
    expect(results.every(result => result.outcome.status === 'started')).toBe(true);
    const root = await finished(input.commandId);
    const originalTask = taskFor(input.commandId)!;
    const originalSessionIds = [...originalTask.sessionIds];
    const ids = state().history.map(entry => entry.id);
    const rows = exposureFor([results[0]!.runId, root.id], input.commandId);
    const calls = seen.length;
    expect((await send(input)).outcome).toEqual(results[0]!.outcome);
    await close();
    await open();
    expect((await send(input)).outcome).toEqual(results[0]!.outcome);
    expect(taskFor(input.commandId)!.id).toBe(originalTask.id);
    expect(taskFor(input.commandId)!.sessionIds).toEqual(originalSessionIds);
    expect(state().tasks).toHaveLength(1);
    expect(state().sessions).toHaveLength(1);
    expect(state().history.map(entry => entry.id)).toEqual(ids);
    expect(exposureFor([results[0]!.runId, root.id], input.commandId)).toEqual(rows);
    expect(seen).toHaveLength(calls);
  });

  test('reusing a normal message command for a changed goal, mode or source pin is refused before any extra send', async () => {
    const input = await message('normal-request-digest');
    await send(input);
    await finished(input.commandId);
    const calls = seen.length;
    for (const changed of [{ ...input, text: 'Write a different report.' }, { ...input, mode: 'plan' },
      { ...input, sources: [] }, { ...input, sources: [{ path: 'inventory.txt', sha: 'f'.repeat(64) }] }]) {
      const refused = await request<{ code?: string }>(messages(), 'POST', changed);
      expect(refused.status).toBe(409);
      expect(seen).toHaveLength(calls);
      expect(state().tasks).toHaveLength(1);
      expect(state().sessions).toHaveLength(1);
    }
  });

  test.each([
    'What does the selected inventory say?',
    'Just say hello.',
    'Plan only: prepare an inventory report without editing anything.',
    'Write the inventory report, but do not change or write any files.',
    'Answer only; read inventory.txt and explain the discrepancy.',
  ])('a non-action or explicitly limited request starts no automatic task or Team: %s', async text => {
    const result = await send(await message('limited-normal-request', text));
    expect(result.outcome.status).not.toBe('started');
    expect(state().tasks).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect(state().team?.members ?? []).toHaveLength(0);
    expect(state().team?.runs ?? []).toHaveLength(0);
    expect((await phases(result)).find(item => item.phase === 'decision')!.body).not.toHaveProperty('automaticWork');
    expect(seen.filter(item => item.kind === 'native')).toHaveLength(0);
  });

  test('a source changed during the conversation is refused before native dispatch and is not retried on replay', async () => {
    holdConversation = true;
    const input = await message('source-changed-before-native');
    const answering = send(input);
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 12_000 });
    await fs.writeFile(path.join(state().project.folder, 'inventory.txt'), 'Changed after this request was admitted.\n');
    held!.release();
    const result = await answering;
    expect(result.outcome).toMatchObject({ status: 'not-started', reason: 'refused' });
    const saved = await phases(result);
    expect(saved.find(item => item.phase === 'work-refused')!.body).toMatchObject({ status: 409, code: 'source_changed' });
    expect(state().tasks).toHaveLength(1);
    expect(taskFor(input.commandId)!.automaticWork!.request.sources).toEqual(input.sources);
    expect(taskFor(input.commandId)!.sessionIds).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(await host().get(projectId, taskFor(input.commandId)!.automaticWork!.rootRunId!).catch(() => null)).toBeNull();
    expect((await send(input)).outcome).toEqual(result.outcome);
    expect(seen).toHaveLength(1);
    expect(state().tasks).toHaveLength(1);
    expect(taskFor(input.commandId)!.state).not.toBe('done');
  });

  test('narrowing the ordinary Mode during its answer fences automatic task and native dispatch', async () => {
    holdConversation = true;
    const input = await message('mode-narrowed-before-native');
    const answering = send(input);
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 12_000 });
    await api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { mode: 'plan' });
    held!.release();
    const result = await answering;
    expect(result.outcome).toMatchObject({ status: 'not-started', reason: 'above-ceiling' });
    expect(state().tasks).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect((await send(input)).outcome).toEqual(result.outcome);
    expect(seen).toHaveLength(1);
  });

  test.each(['model', 'effort'] as const)('changing the original %s while its answer is pending refuses automatic admission without a native send', async field => {
    holdConversation = true;
    const input = await message(`original-${field}-drift`);
    const answering = send(input);
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 12_000 });
    await api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', {
      requested: { model: field === 'model' ? OTHER_MODEL : MODEL, effort: field === 'effort' ? 'high' : 'medium' },
    });
    held!.release();
    const result = await answering;
    expect(result.outcome).toMatchObject({ status: 'not-started', reason: 'refused' });
    const saved = await phases(result);
    expect(saved.find(item => item.phase === 'decision')!.body).toMatchObject({ automaticWork: {
      executionPin: { route: 'openrouter', model: MODEL, effort: 'medium', accountRoute: connection!.accountRoute, profile: null },
    } });
    expect(saved.find(item => item.phase === 'task-refused')!.body).toMatchObject({ status: 409, code: 'stale-request' });
    expect(state().tasks).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect((await host().list(projectId)).filter(run => !['model-api-conversation', 'model-api-turn'].includes(run.capabilityId))).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect((await send(input)).outcome).toEqual(result.outcome);
    expect(seen).toHaveLength(1);
  });

  test('revising the original saved profile while its answer is pending refuses its recorded exact revision before task creation', async () => {
    const draft = { name: 'Synthetic original profile', engine: 'openrouter', model: MODEL, effort: 'medium', agentId: 'auto', rules: [] };
    const original = await api<{ profileId: string; revision: number; digest: string }>('/agent-profiles', 'POST', draft);
    await api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { requested: { profile: original.profileId } });
    holdConversation = true;
    const input = await message('original-profile-revision-drift');
    const answering = send(input);
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 12_000 });
    await api(`/agent-profiles/${original.profileId}`, 'PUT', { ...draft, expectedRevision: original.revision,
      rules: ['Check the exact revised profile, rather than the admitted revision.'] });
    held!.release();
    const result = await answering;
    expect(result.outcome).toMatchObject({ status: 'not-started', reason: 'refused' });
    const saved = await phases(result);
    expect(saved.find(item => item.phase === 'decision')!.body).toMatchObject({ automaticWork: {
      executionPin: { route: 'openrouter', model: MODEL, effort: 'medium', accountRoute: connection!.accountRoute,
        profile: { id: original.profileId, revision: original.revision, digest: rawProfilePin(original.digest) } },
    } });
    expect(saved.find(item => item.phase === 'task-refused')!.body).toMatchObject({ status: 409, code: 'stale-request' });
    expect(state().tasks).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect((await host().list(projectId)).filter(run => !['model-api-conversation', 'model-api-turn'].includes(run.capabilityId))).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect((await send(input)).outcome).toEqual(result.outcome);
    expect(seen).toHaveLength(1);
  });

  test.each(['answer-projection', 'task-persist', 'root-persist'] as const)(
    'a real process exit after %s resumes from durable production receipts without duplicate planning, Task or root', async boundary => {
      const input = await message(`crash-${boundary}`);
      const sourceMessageId = sourceMessageIdFor(projectId, thread.id, input.commandId);
      const captured = chatEvents({ id: 'captured-before-crash', model: MODEL, provider: 'OpenAI', text: decision(sourceMessageId),
        usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, is_byok: false } });
      await close();
      const appUrl = pathToFileURL(path.resolve('server/app.ts')).href;
      const engineUrl = pathToFileURL(path.resolve('server/engines/service.ts')).href;
      const secretUrl = pathToFileURL(path.resolve('server/connection-secrets.ts')).href;
      // Crash injection follows the real fsync/rename persist. It does not forge a
      // receipt, source, grant, selection, profile, admission or model decision phase.
      const program = `import {createApp} from ${JSON.stringify(appUrl)};
import {EngineService} from ${JSON.stringify(engineUrl)};
import {testOnlySecretBox} from ${JSON.stringify(secretUrl)};
let providerCalls=0;
const app=await createApp({dataDir:${JSON.stringify(path.join(dir, 'data'))},projectRoot:${JSON.stringify(path.join(dir, 'projects'))},engineService:new EngineService(${JSON.stringify(path.join(dir, 'engines'))},{discover:async()=>[]}),reviewerAdapter:null,secretBox:testOnlySecretBox(),ownerRoutes:true,accounts:null,observation:null,managedJev:false,modelApiTransport:async(input)=>{const url=typeof input==='string'||input instanceof URL?String(input):input.url;if(url!=='https://openrouter.ai/api/v1/chat/completions')throw new Error('unexpected destination');if(++providerCalls!==1)process.exit(76);return new Response(${JSON.stringify(captured)},{headers:{'content-type':'text/event-stream'}});}});
const saved=app.locals.store.persist.bind(app.locals.store);
app.locals.store.persist=async(state)=>{await saved(state);if(state.project.id!==${JSON.stringify(projectId)})return;
const task=state.tasks.find(item=>item.automaticWork?.request.commandId===${JSON.stringify(input.commandId)});
const projected=state.conversations.find(item=>item.id===${JSON.stringify(thread.id)})?.turns.some(item=>item.role==='assistant');
const rootSession=task&&state.sessions.find(item=>item.taskId===task.id&&item.receipt?.commandId===${JSON.stringify(conversationCommandIds(sourceMessageId).workCommandId)});
const hit=${JSON.stringify(boundary)}==='answer-projection'?projected&&!task:${JSON.stringify(boundary)}==='task-persist'?task&&!rootSession:rootSession;
if(hit){process.stdout.write('qualified-boundary:'+${JSON.stringify(boundary)}+'\\n',()=>process.exit(75));await new Promise(()=>{});}};
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
await fetch('http://127.0.0.1:'+server.address().port+${JSON.stringify(`/api${messages()}`)},{method:'POST',headers:${JSON.stringify(HEADERS)},body:${JSON.stringify(JSON.stringify(input))}});
setTimeout(()=>process.exit(77),12000);`;
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) if (/^(?:DIOMEDES_|MANAGED_|AWS_|NECTOVIA_)/i.test(key)
        || OFFLINE_ENV_REMOVALS.has(key.toUpperCase())) delete env[key];
      env.CODEX_HOME = path.join(dir, 'owned-codex-profile');
      env.WRANGLER_SEND_METRICS = 'false';
      let output = '';
      const code = await new Promise<number | null>((resolve, reject) => {
        childProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program],
          { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        childProcess.stdout?.on('data', chunk => { output += String(chunk); });
        childProcess.stderr?.on('data', chunk => { output += String(chunk); });
        childProcess.once('error', reject);
        childProcess.once('exit', resolve);
      });
      expect(code, output).toBe(75);
      expect(output.match(new RegExp(`qualified-boundary:${boundary}`, 'g'))).toHaveLength(1);
      await open();
      const replay = await send(input);
      expect(replay.outcome.status, JSON.stringify(replay.outcome)).toBe('started');
      const root = await finished(input.commandId);
      expect(state().tasks).toHaveLength(1);
      expect(state().sessions).toHaveLength(1);
      expect(conversation().turns.filter(turn => turn.role === 'you')).toHaveLength(1);
      expect(conversation().turns.filter(turn => turn.role === 'assistant')).toHaveLength(1);
      expect(seen.filter(item => item.kind === 'conversation')).toHaveLength(0);
      expect(seen.filter(item => item.kind === 'native')).toHaveLength(2);
      expect(exposureFor([replay.runId, root.id], input.commandId)).toHaveLength(3);
      expect(new Set(exposureFor([replay.runId, root.id], input.commandId).map(row => row.jobId)))
        .toEqual(new Set([jobKeyFor(projectId, input.commandId)]));
      expect((await phases(replay)).some(item => item.phase === 'action-selected')).toBe(false);
      const before = seen.length;
      expect((await send(input)).outcome).toEqual(replay.outcome);
      expect(seen).toHaveLength(before);
    },
  );
});

describe('real production Team factory, public profile selection and root scope', TEAM_TEST, () => {
  test('F2: production owned Team generations resolve their exact child and parent while sharing the original spend cap', async () => {
    const sink = new MemoryObservationSink();
    await setupPaidTeam({ helper: true, observationSink: sink });
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Observed owned synthetic Team' });
    const result = await startSelectedTeam('observed-owned-child', task.id);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    const need = await waitWriter(result.data.session.id);
    const record = await waitOwnedChild();
    expect(record.status).toBe('completed');
    const child = await host().get(projectId, record.harnessRunId);
    const root = await host().get(projectId, result.data.runId);
    expect(child.input).toMatchObject({ commandId: record.commandId, rootRunId: root.id, parent: record.parent });
    const runtime = app.locals.observation as ObservationRuntime;
    expect(runtime.scopes.resolve(child)).toMatchObject({ own: true, traceRootRunId: root.id, parentRunId: record.parent!.runId,
      scope: { facts: { surface: 'team', class: 'internal-synthetic' } } });
    await host().bridge.flush();
    await runtime.exporter.flush();
    const wire = () => sink.batches.flatMap(body => JSON.parse(body).batch) as { uuid: string; event: string; properties: Record<string, any> }[];
    const generations = wire().filter(event => event.event === '$ai_generation' && event.properties.nectovia_capability === 'model-api-team-work');
    expect(generations).toHaveLength(seen.filter(call => call.kind === 'team').length);
    expect(generations).toHaveLength(1);
    expect(generations[0].properties).toMatchObject({ $ai_trace_id: traceIdFor('test', root.id),
      $ai_parent_id: spanIdFor('test', `${child.id}|run`), nectovia_surface: 'team' });
    const childSpan = wire().find(event => event.properties.$ai_span_id === spanIdFor('test', `${child.id}|run`));
    expect(childSpan?.properties.$ai_parent_id).toBe(traceIdFor('test', record.parent!.runId));
    const childRows = exposureFor([child.id]);
    expect(childRows).toHaveLength(1);
    expect(childRows[0].state).toBe('settled');
    expect(generations[0].properties).toMatchObject({ nectovia_cost_state: 'settled',
      nectovia_cost_micro_usd: childRows[0].settledMicroUsd,
      $ai_total_cost_usd: childRows[0].settledMicroUsd! / 1e6 });
    const helper = (await host().list(projectId)).find(run => run.capabilityId === 'diomedes-loop-worker')!;
    expect(helper.id).not.toBe(child.id);
    const rootInput = root.input as { rootJobId: string; rootJobRequestId: string };
    expect(new Set(exposureFor([root.id, child.id, helper.id]).map(row => row.jobId))).toEqual(new Set([rootInput.rootJobId]));
    const ledger = await service.rootJobLedger(projectId, rootInput.rootJobRequestId);
    expect(ledger.jobScope!.id).toBe(rootInput.rootJobId);
    expect(ledger.jobUsed(rootInput.rootJobId)).toBeLessThanOrEqual(ledger.jobScope!.capMicroUsd);
    const calls = seen.length, uuids = wire().map(event => event.uuid);
    expect((await startSelectedTeam('observed-owned-child', task.id)).data.replayed).toBe(true);
    await runtime.exporter.flush();
    expect(seen).toHaveLength(calls);
    expect(wire().map(event => event.uuid)).toEqual(uuids);
    // Persisted owned metadata is required and cannot borrow a scope by naming a root.
    const changed = structuredClone(child);
    delete (changed.input as Record<string, unknown>).ownedTeam;
    expect(runtime.scopes.resolve(changed)).toBeNull();
    expect(runtime.scopes.resolve({ ...child, id: 'R-unadmitted-other-child' })).toBeNull();
    await approveWriter(need);
    await vi.waitFor(async () => expect((await host().get(projectId, root.id)).state).toBe('completed'), TEAM_WAIT);
  });

  test('F2: an eligible child from another business cannot borrow internal observation', async () => {
    const sink = new MemoryObservationSink();
    await setupPaidTeam({ observationSink: sink, observationOrganization: 'other' });
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Unobserved other-business Team' });
    const result = await startSelectedTeam('other-business-child', task.id);
    expect(result.status).toBe(200);
    const need = await waitWriter(result.data.session.id);
    expect(seen.filter(call => call.kind === 'team')).toHaveLength(1);
    await (app.locals.observation as ObservationRuntime).exporter.flush();
    expect(sink.batches).toHaveLength(0);
    await approveWriter(need);
  });

  test('F3: recreating the actual loop adapter preserves its live boundary and the in-flight generation exactly once', async () => {
    const sink = new MemoryObservationSink();
    await setupPaidTeam({ observationSink: sink });
    const real = service.loopAdapter.bind(service);
    let captured: Parameters<EngineService['loopAdapter']> | undefined;
    const spy = vi.spyOn(service, 'loopAdapter').mockImplementation(async (...args) => {
      captured ??= args;
      return real(...args);
    });
    holdNative = true;
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Recreated adapter observation' });
    const result = await startSelectedTeam('recreated-loop-adapter', task.id);
    expect(result.status).toBe(200);
    await vi.waitFor(() => expect(heldNative).toBeDefined(), TEAM_WAIT);
    const runtime = app.locals.observation as ObservationRuntime;
    const root = await host().get(projectId, result.data.runId);
    const first = runtime.scopes.resolve(root)!.scope;
    const attempt = root.events.find(event => event.type === 'step.started' && root.steps.some(step =>
      step.intent.stepId === event.stepId && step.intent.kind === 'model'))!;
    expect(Date.parse(attempt.at)).toBeGreaterThanOrEqual(first.boundAt);
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(attempt.at)));
    expect(captured).toBeDefined();
    await real(...captured!);
    const again = runtime.scopes.resolve(root)!.scope;
    expect(again.boundAt).toBe(first.boundAt);
    expect(again.facts.admissionId).not.toBe(first.facts.admissionId);
    heldNative!.release();
    const need = await waitWriter(result.data.session.id);
    await host().bridge.flush();
    await runtime.exporter.flush();
    const span = spanIdFor('test', `${root.id}|${attempt.stepId}|${attempt.attempt}`);
    const events = () => sink.batches.flatMap(body => JSON.parse(body).batch) as { event: string; properties: Record<string, any> }[];
    expect(events().filter(event => event.event === '$ai_generation' && event.properties.$ai_span_id === span)).toHaveLength(1);
    await runtime.exporter.flush();
    expect(events().filter(event => event.event === '$ai_generation' && event.properties.$ai_span_id === span)).toHaveLength(1);
    spy.mockRestore();
    await approveWriter(need);
  });

  test('F2: disabled observation exports nothing from an otherwise admitted production Team child', async () => {
    const sink = new MemoryObservationSink();
    await setupPaidTeam({ observationSink: sink, observationDisabled: true });
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Observation disabled Team' });
    const result = await startSelectedTeam('disabled-observation-child', task.id);
    expect(result.status).toBe(200);
    const need = await waitWriter(result.data.session.id);
    const child = await host().get(projectId, (await waitOwnedChild()).harnessRunId);
    expect(seen.filter(call => call.kind === 'team')).toHaveLength(1);
    expect(child.state).toBe('completed');
    expect(app.locals.observation).toBeNull();
    expect(sink.batches).toHaveLength(0);
    await approveWriter(need);
  });

  test('F2: signing out drops a real queued child generation and signing back in cannot revive it', async () => {
    const sink = new MemoryObservationSink();
    await setupPaidTeam({ observationSink: sink });
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Withdraw observation before flush' });
    const result = await startSelectedTeam('signout-before-child-flush', task.id);
    expect(result.status).toBe(200);
    await waitWriter(result.data.session.id);
    const child = await host().get(projectId, (await waitOwnedChild()).harnessRunId);
    const runtime = app.locals.observation as ObservationRuntime;
    const resolved = runtime.scopes.resolve(child);
    expect(resolved, 'The real admitted owned child must have its own Team scope before withdrawal.').not.toBeNull();
    const scope = resolved!.scope;
    expect(runtime.scopes.recheck(scope).live).toBe(true);
    const calls = seen.length;
    await api('/account/sign-out', 'POST', {});
    await runtime.exporter.flush();
    expect(sink.batches).toHaveLength(0);
    expect(runtime.scopes.recheck(scope).live).toBe(false);
    await api('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    await runtime.exporter.flush();
    expect(runtime.scopes.recheck(scope).live).toBe(false);
    expect(sink.batches).toHaveLength(0);
    expect(seen).toHaveLength(calls);
  });

  test('one normal request selects a measured fixture pair and links its real child, mailbox and Board without a selection phase', async () => {
    await setupPaidTeam({ qualified: true });
    teamResponse = 'try-done';
    const input = await message('automatic-real-team');
    const result = await send(input);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('started');
    if (result.outcome.status !== 'started') throw new Error('Automatic Team work did not start.');
    const need = await waitWriter(result.outcome.sessionId);
    const record = await waitOwnedChild();
    expect(record).toMatchObject({ ownership: 'agent-team-response', status: 'completed', sessionId: null,
      rootTaskId: result.outcome.taskId, rootRunId: taskFor(input.commandId)!.automaticWork!.rootRunId,
      unknownOutcome: false, result: { runId: record.harnessRunId, model: expect.stringContaining(OTHER_MODEL) } });
    const assignment = state().tasks.find(task => task.id === record.assignmentTaskId)!;
    expect(assignment.ownedAssignment).toEqual({ rootTaskId: record.rootTaskId, rootRunId: record.rootRunId, admissionRef: record.grant.id });
    expect(assignment.workflow).toMatchObject({ parentTaskId: record.rootTaskId, continuation: 'full-approval' });
    expect(assignment.workflow!.maxTurns).toBeLessThanOrEqual(6);
    expect(assignment.state).toBe('waiting');
    expect(assignment.reason).toBe('changes-ready');
    expect(assignment.sessionIds).toHaveLength(0);
    const child = await host().get(projectId, record.harnessRunId);
    expect(child.state).toBe('completed');
    expect(child.result).not.toBeNull();
    const deniedDone = child.steps.find(step => step.intent.name === 'team_task_update');
    expect(deniedDone?.output).toMatchObject({ error: expect.stringContaining('cannot mark') });
    const native = await host().get(projectId, record.rootRunId);
    expect(native.input).toMatchObject({ collaboration: { qualityStatus: 'measured', persistentTeam: {
      lead: { slotId: teamFixture!.lead.slotId, effort: 'medium', profile: { id: teamFixture!.leadProfile.profileId, revision: 1,
        digest: rawProfilePin(teamFixture!.leadProfile.digest) } },
      member: { slotId: teamFixture!.worker.slotId, effort: 'medium', profile: { id: teamFixture!.workerProfile.profileId, revision: 1,
        digest: rawProfilePin(teamFixture!.workerProfile.digest) } },
    } } });
    expect(taskFor(input.commandId)!.automaticWork!.teamDecision).toMatchObject({ mode: 'team', reserve: {
      workerMicroUsd: 40_000, verificationMicroUsd: 50_000, correctionMicroUsd: 50_000, coordinationMicroUsd: 50_000,
    } });
    expect(taskFor(input.commandId)!.automaticWork!.request.executionPin!.profile)
      .toEqual({ id: teamFixture!.leadProfile.profileId, revision: 1, digest: rawProfilePin(teamFixture!.leadProfile.digest) });
    expect((await phases(result)).some(item => item.phase === 'action-selected')).toBe(false);
    expect(state().tasks).toHaveLength(2);
    expect(state().sessions).toHaveLength(1);
    expect(state().team!.runs.filter(isOwnedTeamRun)).toHaveLength(1);
    expect(state().team!.messages.filter(mail => mail.id === record.requestMessageId)).toHaveLength(1);
    expect(state().team!.messages.filter(mail => mail.id === record.replyMessageId)).toHaveLength(1);
    expect(state().team!.messages.find(mail => mail.id === record.replyMessageId)!.content).toContain('inventory.txt');
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
    expect(taskFor(input.commandId)!.state).not.toBe('done');
    const standalone = await request<{ code: string }>(`/projects/${projectId}/work/start`, 'POST', {
      taskId: assignment.id, route: 'openrouter', consent: true, sources: ['inventory.txt'],
    });
    expect(standalone.status).toBe(409);
    expect(standalone.data.code).toBe('task_workflow_blocked');
    await approveWriter(need);
    await finished(input.commandId);
    await vi.waitFor(() => expect(ownedTeam().rootClosed).toBe(true), TEAM_WAIT);
    expect(taskFor(input.commandId)!.state).not.toBe('done');
    expect(state().tasks.find(task => task.id === assignment.id)!.state).not.toBe('done');
    const rows = exposureFor([result.runId, native.id, child.id], input.commandId);
    expect(rows.length).toBe(seen.length);
    expect(new Set(rows.map(row => row.jobId))).toEqual(new Set([jobKeyFor(projectId, input.commandId)]));
    expect(seen.filter(call => call.kind === 'team')).toHaveLength(2);
    const before = seen.length;
    expect((await send(input)).outcome).toEqual(result.outcome);
    expect(state().tasks).toHaveLength(2);
    expect(state().sessions).toHaveLength(1);
    expect(seen).toHaveLength(before);
  });

  test('explicit selected profiles cold-start honestly as hypothesis and H14 plus owned Team calls use the one existing root cap', async () => {
    await setupPaidTeam({ helper: true });
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Explicit bounded selected Team' });
    const result = await startSelectedTeam('explicit-cold-start', task.id);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    const need = await waitWriter(result.data.session.id);
    const record = await waitOwnedChild();
    expect(record.status).toBe('completed');
    const root = await host().get(projectId, result.data.runId);
    expect(root.input).toMatchObject({ collaboration: { qualityStatus: 'hypothesis',
      selectionReason: expect.stringContaining('unmeasured') } });
    expect(state().team!.qualifications ?? []).toHaveLength(0);
    const helper = (await host().list(projectId)).find(run => run.capabilityId === 'diomedes-loop-worker');
    expect(helper, 'the selected production H14 helper actually ran').toBeDefined();
    expect(helper).toMatchObject({ state: 'completed', sessionId: null, taskId: task.id });
    expect(helper!.id).not.toBe(record.harnessRunId);
    expect((helper!.input as { parent?: { runId?: string } }).parent?.runId).toBe(root.id);
    expect(seen.filter(call => call.kind === 'team')).toHaveLength(1);
    expect(seen.filter(call => call.kind === 'helper')).toHaveLength(1);
    for (const call of seen.filter(item => item.kind === 'team' || item.kind === 'helper')) {
      expect(call.body.max_tokens, 'selected Team and distinct H14 calls retain the bounded output envelope').toBeLessThanOrEqual(4096);
    }
    await approveWriter(need);
    await vi.waitFor(async () => expect((await host().get(projectId, root.id)).state).toBe('completed'), TEAM_WAIT);
    await host().bridge.flush();
    await vi.waitFor(() => expect(ownedTeam().rootClosed).toBe(true), TEAM_WAIT);
    const rows = exposureFor([root.id, record.harnessRunId, helper!.id]);
    const rootJob = (root.input as { rootJobId: string; rootJobRequestId: string }).rootJobId;
    expect(new Set(rows.map(row => row.jobId))).toEqual(new Set([rootJob]));
    expect(rows.length).toBe(seen.length);
    const ledger = await service.rootJobLedger(projectId, (root.input as { rootJobRequestId: string }).rootJobRequestId);
    expect(ledger.jobScope!.id).toBe(rootJob);
    expect(ledger.jobUsed(rootJob)).toBeLessThanOrEqual(ledger.jobScope!.capMicroUsd);
    expect(state().sessions).toHaveLength(1);
    expect(state().tasks.find(item => item.id === task.id)!.state).not.toBe('done');
    expect(state().team!.members.every(member => member.status === 'idle')).toBe(true);
  });

  test('an allocation smaller than the first worker hold refuses through the production factory before any child SDK send', async () => {
    await setupPaidTeam({ qualified: true, workerBudget: 1_000 });
    const input = await message('worker-bound-before-first-dispatch');
    const result = await send(input);
    expect(result.outcome.status).toBe('started');
    const record = await waitOwnedChild();
    await vi.waitFor(async () => expect((await host().get(projectId, record.harnessRunId)).steps
      .some(step => step.error?.code === 'openrouter_spend_refused' && step.error.message.includes('allocation'))).toBe(true), TEAM_WAIT);
    const task = taskFor(input.commandId)!;
    expect(task.automaticWork!.teamDecision).toMatchObject({ mode: 'team', reserve: { workerMicroUsd: 1_000 } });
    expect(seen.filter(call => call.kind === 'team')).toHaveLength(0);
    expect(exposureFor([record.harnessRunId])).toHaveLength(0);
    const ledger = await service.rootJobLedger(projectId, input.commandId, thread.id);
    expect(ledger.jobScope!.capMicroUsd - ledger.jobUsed(ledger.jobScope!.id)).toBeGreaterThan(150_000);
    expect(record.result).toBeNull();
    expect(task.state).not.toBe('done');
    expect(state().needs.some(need => need.approval)).toBe(false);
    const saved = await host().get(projectId, record.harnessRunId);
    const attempted = saved.steps.find(step => step.intent.kind === 'model')!;
    const current = await service.modelApi!.openrouter!.connections.read();
    await expect(ledger.reserve({ connectionId: connection!.id, route: 'openrouter', modelId: OTHER_MODEL,
      attempt: { runId: record.harnessRunId, stepId: 'independent-budget-proof', attempt: 1, requestDigest: 'a'.repeat(64) },
      card: openRouterRateCard(current!, OTHER_MODEL), maxMicroUsd: micro(2_000) }))
      .rejects.toMatchObject({ code: 'run_budget_reached', runId: record.harnessRunId, capMicroUsd: 1_000 });
    expect(attempted.output).toBeNull();
  });

  test('a draining real worker cannot use the lead verification and correction allocation or obtain its full six sends', async () => {
    await setupPaidTeam({ qualified: true, workerBudget: 20_000 });
    // With a 4,096 output ceiling, six 4,000-token answers cost at least $0.024.
    // A $0.020 worker allocation must run out while the root still has headroom.
    teamResponse = 'drain';
    const input = await message('worker-drain-is-contained');
    const result = await send(input);
    expect(result.outcome.status).toBe('started');
    const record = await waitOwnedChild();
    await vi.waitFor(async () => expect((await host().get(projectId, record.harnessRunId)).steps
      .some(step => step.error?.code === 'openrouter_spend_refused' && step.error.message.includes('allocation'))).toBe(true), TEAM_WAIT);
    const calls = seen.filter(call => call.kind === 'team');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(6);
    const rows = exposureFor([record.harnessRunId]);
    expect(rows.length).toBe(calls.length);
    const held = rows.reduce((sum, row) => sum + (row.settledMicroUsd ?? row.maxMicroUsd), 0);
    expect(held).toBeLessThanOrEqual(20_000);
    const ledger = await service.rootJobLedger(projectId, input.commandId, thread.id);
    expect(new Set(rows.map(row => row.jobId))).toEqual(new Set([jobKeyFor(projectId, input.commandId)]));
    expect(ledger.jobScope!.capMicroUsd - ledger.jobUsed(ledger.jobScope!.id)).toBeGreaterThan(150_000);
    expect(record.result).toBeNull();
    expect(taskFor(input.commandId)!.state).not.toBe('done');
    expect(state().needs.some(need => need.approval)).toBe(false);
  });

  test('public Stop fences a real owned response and its late SDK result; restart and original-command replay do not resend', async () => {
    const sink = new MemoryObservationSink();
    await setupPaidTeam({ qualified: true, observationSink: sink });
    teamResponse = 'hold';
    const input = await message('stop-real-owned-response');
    const result = await send(input);
    expect(result.outcome.status).toBe('started');
    if (result.outcome.status !== 'started') throw new Error('No root was started.');
    await vi.waitFor(() => expect(heldTeam).toBeDefined(), TEAM_WAIT);
    const record = await waitOwnedChild();
    const pending = exposureFor([record.harnessRunId]);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.maxMicroUsd).toBeGreaterThan(0);
    const callCount = seen.length;
    await api(`/projects/${projectId}/work/${result.outcome.sessionId}/stop`, 'POST', {});
    await vi.waitFor(async () => expect((await host().get(projectId, record.harnessRunId)).state).toBe('cancelled'), TEAM_WAIT);
    await vi.waitFor(async () => expect((await host().get(projectId, record.rootRunId)).state).toBe('cancelled'), TEAM_WAIT);
    expect(heldTeam!.signal!.aborted).toBe(true);
    heldTeam!.release();
    await vi.waitFor(() => expect(exposureFor([record.harnessRunId])[0]!.state).toBe('uncertain'), TEAM_WAIT);
    await host().bridge.flush();
    expect(ownedTeam()).toMatchObject({ rootClosed: true, unknownOutcome: true, result: null, replyMessageId: null });
    const child = await host().get(projectId, record.harnessRunId);
    expect(child.result).toBeNull();
    expect(child.steps.some(step => step.intent.kind === 'model' && step.state === 'reconcile_required' && step.output === null)).toBe(true);
    expect(state().team!.messages.some(mail => mail.from === teamFixture!.worker.slotId)).toBe(false);
    expect(state().tasks.every(task => task.state !== 'done')).toBe(true);
    expect(state().needs.some(need => need.approval)).toBe(false);
    const progress = state().history.filter(entry => entry.kind === 'task-progress' && entry.taskId === record.rootTaskId);
    expect(progress.at(-1)!.progress).toMatchObject({ certainty: 'unknown', retry: 'reconcile-first' });
    const heldMoney = exposureFor([record.harnessRunId]);
    await (app.locals.observation as ObservationRuntime).exporter.flush();
    const observationBeforeRestart = structuredClone(sink.batches);
    await close();
    await open();
    expect((await send(input)).outcome).toEqual(result.outcome);
    expect(seen).toHaveLength(callCount);
    expect(state().tasks).toHaveLength(2);
    expect(state().sessions).toHaveLength(1);
    expect(ownedTeam()).toMatchObject({ harnessRunId: record.harnessRunId, rootClosed: true, unknownOutcome: true, replyMessageId: null, result: null });
    expect(exposureFor([record.harnessRunId])).toEqual(heldMoney);
    const recovered = app.locals.observation as ObservationRuntime;
    expect(recovered.scopes.resolve(await host().get(projectId, record.harnessRunId))).toBeNull();
    await recovered.exporter.flush();
    expect(sink.batches).toEqual(observationBeforeRestart);
  });

  test.each(['source', 'profile', 'trust'] as const)('fresh %s refusal prevents a held Team result from creating a reply, report or further dispatch', async change => {
    await setupPaidTeam({ qualified: true });
    teamResponse = 'hold';
    const input = await message(`team-${change}-revoked-before-result`);
    const result = await send(input);
    expect(result.outcome.status).toBe('started');
    await vi.waitFor(() => expect(heldTeam).toBeDefined(), TEAM_WAIT);
    const record = await waitOwnedChild();
    if (change === 'source') await fs.writeFile(path.join(state().project.folder, 'inventory.txt'), 'Changed during the exact admitted response.\n');
    if (change === 'profile') await api(`/agent-profiles/${teamFixture!.workerProfile.profileId}`, 'PUT', {
      expectedRevision: teamFixture!.workerProfile.revision, name: teamFixture!.workerProfile.name, engine: 'openrouter',
      model: OTHER_MODEL, effort: 'medium', agentId: 'auto', rules: ['Revised after the admitted child dispatch.'],
    });
    if (change === 'trust') identityAvailable = false;
    const calls = seen.length;
    heldTeam!.release();
    await vi.waitFor(async () => expect((await host().get(projectId, record.harnessRunId)).steps
      .some(step => step.error?.code === 'collaboration_refused')).toBe(true), TEAM_WAIT);
    await host().bridge.flush();
    expect(ownedTeam().result).toBeNull();
    expect(ownedTeam().replyMessageId).toBeNull();
    expect((await host().get(projectId, record.harnessRunId)).result).toBeNull();
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
    expect(state().needs.some(need => need.approval)).toBe(false);
    expect(state().tasks.every(task => task.state !== 'done')).toBe(true);
    expect(seen).toHaveLength(calls);
  });

  test('the public selected-Team path refuses absent owner identity before any SDK send or child effect', async () => {
    await setupPaidTeam({ identity: 'deny' });
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Unqualified identity Team' });
    const result = await startSelectedTeam('missing-genuine-owner-identity', task.id);
    expect(result.status).toBe(409);
    expect(result.data.code).toBe('collaboration_refused');
    expect(result.data.error).toContain('Trust authority');
    expect(seen).toHaveLength(0);
    expect(await host().list(projectId)).toHaveLength(0);
    expect(state().team!.runs).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect(service.modelApi!.exposure.list(connection!.id)).toHaveLength(0);
  });

  test.each(['model', 'account', 'effort'] as const)('the public selected lead refuses a mismatched %s before model or child dispatch', async field => {
    await setupPaidTeam();
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Exact selected root binding' });
    const changed = field === 'model' ? { model: OTHER_MODEL } : field === 'account' ? { accountRoute: 'openrouter:wrong-account@r999' } : { effort: 'high' };
    const result = await startSelectedTeam(`selected-lead-${field}-drift`, task.id, changed);
    expect(result.status).toBe(409);
    expect(result.data.code).toBe('collaboration_refused');
    expect(result.data.error).toContain('differs from the selected Team lead');
    expect(seen).toHaveLength(0);
    expect(await host().list(projectId)).toHaveLength(0);
    expect(state().team!.runs).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect(service.modelApi!.exposure.list(connection!.id)).toHaveLength(0);
  });

  test('a stopped selected member cannot be admitted by a new root through the public cold-start path', async () => {
    await setupPaidTeam();
    await api(`/projects/${projectId}/team/members/${teamFixture!.worker.slotId}/stop`, 'POST', {});
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Stopped selected member' });
    const result = await startSelectedTeam('new-root-with-stopped-member', task.id);
    expect(result.status).toBe(409);
    expect(result.data.code).toBe('collaboration_refused');
    expect(result.data.error).toContain('stopped');
    expect(seen).toHaveLength(0);
    expect(await host().list(projectId)).toHaveLength(0);
    expect(state().team!.runs).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect(service.modelApi!.exposure.list(connection!.id)).toHaveLength(0);
  });

  test('the public fixed Jev selection reports its missing Decisions/account qualification and sends nothing', async () => {
    await setupPaidTeam();
    const task = await api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Unqualified fixed review' });
    const result = await startSelectedTeam('unqualified-public-jev', task.id, {
      review: { profileId: 'agent.inventory-reconciliation', connectionId: connection!.id },
    });
    expect(result.status).toBe(409);
    expect(result.data.code).toBe('review_unqualified');
    expect(result.data.error).toContain('Decisions billing qualification');
    expect(seen).toHaveLength(0);
    expect(await host().list(projectId)).toHaveLength(0);
    expect(state().team!.runs).toHaveLength(0);
    expect(state().sessions).toHaveLength(0);
    expect(service.modelApi!.exposure.list(connection!.id)).toHaveLength(0);
  });
});

describe('fresh explicit Team ownership after host restart', TEAM_TEST, () => {
  test('a closed uncertain response keeps exact history and spend while a new command binds one distinct response', async () => {
    await setupPaidTeam({ helper: true });
    teamResponse = 'hold';
    const task = await api<Task>('/projects/' + projectId + '/tasks', 'POST', { name: 'Restart a bounded Team' });
    const first = await startSelectedTeam('restart-team-old', task.id);
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    await vi.waitFor(() => expect(heldTeam).toBeDefined(), TEAM_WAIT);
    const oldRecord = await waitOwnedChild();
    await api('/projects/' + projectId + '/work/' + first.data.session.id + '/stop', 'POST', {});
    expect(heldTeam!.signal!.aborted).toBe(true);
    heldTeam!.release();
    await vi.waitFor(() => expect(exposureFor([oldRecord.harnessRunId])[0]!.state).toBe('uncertain'), TEAM_WAIT);
    await host().bridge.flush();
    // Stop writes the stopped summary and member status with the closed record (DIO-209).
    // Snapshot only once that summary is saved, or the copy is not terminal.
    await vi.waitFor(() => expect(ownedTeam()).toMatchObject({ status: 'cancelled', rootClosed: true, unknownOutcome: true,
      summary: expect.any(String) }), TEAM_WAIT);
    const teamBefore = structuredClone(state().team);
    const oldRoot = await host().get(projectId, first.data.runId);
    const oldChild = await host().get(projectId, oldRecord.harnessRunId);
    const oldMoney = exposureFor([oldRecord.harnessRunId]);
    const callsBefore = structuredClone(seen);
    for (let repeat = 0; repeat < 2; repeat++) {
      await close(); await open();
      expect.soft(state().team, 'Terminal Team history is exact across actual host recreation.').toEqual(teamBefore);
      expect(await host().get(projectId, first.data.runId)).toEqual(oldRoot);
      expect(await host().get(projectId, oldRecord.harnessRunId)).toEqual(oldChild);
      expect(exposureFor([oldRecord.harnessRunId])).toEqual(oldMoney);
      expect(seen).toEqual(callsBefore);
    }
    const replay = await startSelectedTeam('restart-team-old', task.id);
    expect(replay.data).toMatchObject({ runId: first.data.runId, replayed: true });
    expect(seen).toEqual(callsBefore);
    // The old unknown response still cannot cause an ordinary Team wake.
    const wake = await request<{ error: string }>('/projects/' + projectId + '/team/members/' + teamFixture!.worker.slotId + '/wake', 'POST', {});
    expect(wake.status).toBe(409);
    expect(wake.data.error).toMatch(/owned|root/i);
    expect(seen).toEqual(callsBefore);
    teamResponse = 'normal';
    const fresh = await startSelectedTeam('restart-team-fresh', task.id);
    expect(fresh.status, JSON.stringify(fresh.data)).toBe(200);
    expect(fresh.data.runId).not.toBe(first.data.runId);
    const need = await waitWriter(fresh.data.session.id);
    const records = state().team!.runs.filter(isOwnedTeamRun);
    expect(records).toHaveLength(2);
    const next = records.find(record => record.rootRunId === fresh.data.runId)!;
    expect(next).toMatchObject({ status: 'completed', rootClosed: false, unknownOutcome: false,
      rootTaskId: task.id, parent: { runId: fresh.data.runId }, result: { runId: next.harnessRunId } });
    expect(next.harnessRunId).not.toBe(oldRecord.harnessRunId);
    expect(next.assignmentTaskId).not.toBe(oldRecord.assignmentTaskId);
    expect(next.grant.id).not.toBe(oldRecord.grant.id);
    expect((await host().get(projectId, next.harnessRunId)).input).toMatchObject({
      rootRunId: fresh.data.runId, parent: next.parent,
      ownedTeam: { grantId: next.grant.id, teamRunId: next.id, assignmentTaskId: next.assignmentTaskId, parent: next.parent },
    });
    expect(state().team!.messages.filter(mail => mail.from === teamFixture!.worker.slotId)).toHaveLength(1);
    expect(seen.filter(call => call.kind === 'team')).toHaveLength(2);
    expect(seen.filter(call => call.kind === 'helper')).toHaveLength(1);
    const callCount = seen.length;
    const duplicate = await startSelectedTeam('restart-team-fresh', task.id);
    expect(duplicate.data).toMatchObject({ runId: fresh.data.runId, replayed: true });
    expect(seen).toHaveLength(callCount);
    await approveWriter(need);
    await vi.waitFor(async () => expect((await host().get(projectId, fresh.data.runId)).state).toBe('completed'), TEAM_WAIT);
    await host().bridge.flush();
    expect(await host().get(projectId, first.data.runId)).toEqual(oldRoot);
    expect(await host().get(projectId, oldRecord.harnessRunId)).toEqual(oldChild);
    expect(state().team!.runs.find(record => record.id === oldRecord.id)).toEqual(teamBefore!.runs.find(record => record.id === oldRecord.id));
    expect(exposureFor([oldRecord.harnessRunId])).toEqual(oldMoney);
    const root = await host().get(projectId, fresh.data.runId);
    const input = root.input as { rootJobId: string; rootJobRequestId: string };
    expect(input.rootJobId).not.toBe((oldRoot.input as { rootJobId: string }).rootJobId);
    const ledger = await service.rootJobLedger(projectId, input.rootJobRequestId);
    expect(ledger.jobUsed(input.rootJobId)).toBeLessThanOrEqual(ledger.jobScope!.capMicroUsd);
    expect(new Set(exposureFor([root.id, next.harnessRunId]).map(row => row.jobId))).toEqual(new Set([input.rootJobId]));
  });
});
