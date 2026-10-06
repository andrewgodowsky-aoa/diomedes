/**
 * DIO-216 fixtures shared by the Agent Team host test and its Console spec. One scripted transport
 * answers Azure (a Sol lead), AWS (a Kimi K3 helper) and the local server (the member) by host; a
 * mocked local host reports which profile runs; a fixture Trust backend stands for the person at
 * this computer, and a fixture gate for a paid plan that includes Agent work. Nothing here reaches
 * a provider or a real local model, and nothing here starts one. No test framework is imported, so
 * vitest and Playwright both use it.
 */
import path from 'node:path';
import { AWS_BEDROCK_SDK, AWS_RESPONSES_ENDPOINTS, awsQualificationIdentity } from '../../server/engines/aws-bedrock.js';
import { RouteQualifications } from '../../server/engines/route-qualification-store.js';
import { LocalModelError, LOCAL_MODEL_NOT_RUNNING, type LocalModelHost } from '../../server/bonsai/runtime.js';
import type { Principal, TrustBackend } from '../../server/trust/index.js';
import type { AgentGatePort } from '../../server/accounts/agent-gate.js';
import type { LocalModelStatus } from '../../shared/local-model.js';
import { BONSAI_MODEL, localAnswerStream } from './local-model.js';
import { AWS_KIMI_K3, type AwsConnectionView, type AzureConnectionView } from '../../shared/model-api.js';
import type { TeamMember } from '../../shared/types.js';
import { chatEvents, responsesEvents, sseResponse } from './model-api-streams.js';
import { passingReceipt } from './route-qualification-receipts.js';

export const K3 = AWS_KIMI_K3.model;
export const SOL = 'gpt-5.6-sol';
export const AZURE_HOST = 'https://contoso-ai.openai.azure.com/';
export const AWS_BASE = AWS_RESPONSES_ENDPOINTS['us-east-1'];
export const LOCAL_BASE = 'http://127.0.0.1:18082/';
export const ORDER = 'Order 1182: 100 napkins, 40 tablecloths.\n';
export const DELIVERY = 'Delivered 94 napkins and 40 tablecloths. Six napkins short.\n';
export const MEMBER_ANSWER = 'delivery.md: six napkins short.';
export const HELPER_ANSWER = 'order.md asks for 100 napkins and delivery.md shows 94, so six are short.';
export const REPORT = '# Linen delivery\n\nSix napkins are short: 100 ordered, 94 delivered.\n';
export const SOURCES = ['order.md', 'delivery.md'];
/** The Gaming profile as the local model's folder lists it (`tests/fixtures/local-model.ts`). */
export const LOCAL_GAMING = 'local:gaming';
export const LOCAL_FULL = 'local:full';
const rates = {
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 15,
  cacheReadUsdPerMillion: null,
  cacheWriteUsdPerMillion: null,
  source: 'Synthetic fixture price, declared by the test owner',
};

export type TeamRoute = 'azure-openai' | 'aws-bedrock' | 'bonsai';
export interface TeamCall {
  route: TeamRoute;
  url: string;
  body: Record<string, unknown> | null;
}
/** What the fixtures saw and what the local host reports. Tests change `running` and `installed`. */
export interface TeamFixture {
  calls: TeamCall[];
  /** The tool outputs the lead saw on its latest call, for assertions and failure messages. */
  leadOutputs: unknown[];
  memberSlotId: string;
  /** The running profile's name in the local model's folder (`Gaming`, `Full`), or null. */
  running: string | null;
  installed: boolean;
  inspects: number;
  /** The options of every acquire. Only the person's own Start may ask for `start: true`. */
  acquires: ({ start?: boolean } | undefined)[];
}
export const teamFixture = (): TeamFixture => ({
  calls: [], leadOutputs: [], memberSlotId: '', running: 'Gaming', installed: true, inspects: 0, acquires: [],
});

type Item = Record<string, unknown>;
/** The scripted Azure lead: a plan, one assignment and request for the member, one helper task, the report. */
function leadAnswer(fixture: TeamFixture, body: Record<string, unknown>, n: number): Response {
  const input = (body.input as Item[] | undefined) ?? [];
  const tools = (body.tools as unknown[] | undefined) ?? [];
  const outputs = input.filter((item) => item.type === 'function_call_output');
  fixture.leadOutputs = outputs.map((item) => item.output);
  const message = (text: string): Item => ({
    type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
  const call = (name: string, args: unknown): Item => ({
    type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args), status: 'completed',
  });
  const steps: [string, unknown][] = [
    ['team_task_create', { subject: 'Say what is short in the delivery', owner: fixture.memberSlotId }],
    ['team_send_message', { to: fixture.memberSlotId, message: 'Read delivery.md and say what is short.', files: ['delivery.md'] }],
    ['assign_workers', { tasks: [{ task: 'Compare order.md with delivery.md and count the napkins.', files: SOURCES }] }],
    ['propose_write', { text: REPORT }],
  ];
  const output = !tools.length
    ? message('1. Ask the member.\n2. Ask the helper.\n3. Propose the report.')
    : outputs.length < steps.length
      ? call(...steps[outputs.length])
      : message('The report is proposed.');
  const response = {
    id: `resp_sol_${n}`, object: 'response', created_at: 1_790_000_000, status: 'completed', model: `${SOL}-2026-09-01`,
    output: [{ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `enc-sol-${n}` }, output],
    usage: { input_tokens: 400, input_tokens_details: { cached_tokens: 0 }, output_tokens: 60, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 460 },
    incomplete_details: null, error: null,
  };
  return sseResponse(responsesEvents(response), { 'apim-request-id': `apim-${n}` });
}

/** The scripted local member: it answers the lead's request from the attached source. */
function memberAnswer(target: string): Response {
  if (target.endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
  if (target.endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
  if (target !== `${LOCAL_BASE}v1/chat/completions`) throw new Error(`The local fixture never answers ${target}.`);
  const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
  // The local route reads a stream (DIO-247), in llama.cpp's final-chunk order.
  return localAnswerStream({ id: 'local-1', model: BONSAI_MODEL, usage, choices: [{ finish_reason: 'stop', message: { content: MEMBER_ANSWER } }] });
}

/** One transport for every route, by host. Anything else is refused, never fetched. */
export function teamTransport(fixture: TeamFixture): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const route: TeamRoute | null = target.startsWith(AZURE_HOST) ? 'azure-openai'
      : target.startsWith(AWS_BASE) ? 'aws-bedrock' : target.startsWith(LOCAL_BASE) ? 'bonsai' : null;
    if (!route) throw new Error(`This fixture never reaches ${target}.`);
    fixture.calls.push({ route, url: target, body });
    if (route === 'azure-openai') return leadAnswer(fixture, body!, fixture.calls.length);
    if (route === 'bonsai') return memberAnswer(target);
    return sseResponse(chatEvents({ id: `chatcmpl-k3-${fixture.calls.length}`, model: K3, text: HELPER_ANSWER,
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 12 } } }),
    { 'x-amzn-requestid': `req-k3-${fixture.calls.length}` });
  }) as typeof globalThis.fetch;
}

/** The local host: an inspect reports which profile runs; an acquire never starts one unless asked. */
export function localHost(fixture: TeamFixture): LocalModelHost {
  return {
    inspect: async (): Promise<LocalModelStatus> => {
      fixture.inspects += 1;
      return !fixture.installed
        ? { state: 'missing', installed: false, mode: null, owned: false, detail: 'Not installed.' }
        : fixture.running
          ? { state: 'ready', installed: true, mode: fixture.running, owned: true, detail: `${fixture.running} is ready.` }
          : { state: 'unloaded', installed: true, mode: null, owned: false, detail: 'Choose a profile.' };
    },
    // A send acquires without starting: a profile that isn't the running one is refused, as the host script does.
    acquire: async (profile, options) => {
      fixture.acquires.push(options);
      if (fixture.running !== profile.mode && !options?.start) throw new LocalModelError('unloaded', LOCAL_MODEL_NOT_RUNNING);
      return { status: { state: 'ready' as const, installed: true, mode: profile.mode, owned: true, detail: 'Ready.' }, release: async () => {} };
    },
  };
}

/** The person at this computer, as a protected desktop host proves them. A fixture, not a sign-in. */
const owner = (id: string): Principal => ({ kind: 'local-owner', id, tenantId: null, projectId: null, deviceId: null, sessionId: null, slotId: null });
export const fixtureTrust: TrustBackend = {
  lookupTeamMember: async () => null,
  lookupPrincipalRef: async (reference) => (reference.kind === 'local-owner' ? owner(reference.id) : null),
  localOwner: async (ownerId) => owner(ownerId),
};
/** A paid plan that includes Agent work, as the account service would admit it. */
export const fixtureGate: AgentGatePort = {
  check: async (work) => ({
    admissionId: 'fixture-admission', organizationId: null, personId: 'fixture-person', planId: 'individual',
    policyRevision: 1, routeKind: work.routeKind ?? 'byo', surface: work.surface, validUntil: '2099-01-01T00:00:00.000Z',
  }),
};

type Api = <T = any>(route: string, method?: string, body?: unknown) => Promise<T>;
/**
 * Azure on a Sol deployment and AWS on K3, each with a spend limit, a passing route check for the
 * K3 connection, and the two sources shared with all three routes.
 */
export async function connectTeamRoutes(api: Api, dataDir: string, projectId: string) {
  const azure = await api<AzureConnectionView>('/ai/model-api/azure-openai', 'PUT', {
    resourceName: 'contoso-ai',
    deployments: [{ model: SOL, deployment: 'sol-prod', reasoning: true, rates }],
    apiKey: 'test-only-azure-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/azure-openai/spend-limit', 'PUT', { capUsd: 5, consent: true });
  const aws = await api<AwsConnectionView>('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: K3,
    apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
  });
  const awsConnection = aws.connection!;
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
  await new RouteQualifications(path.resolve(dataDir)).record(passingReceipt({
    ...awsQualificationIdentity({ id: awsConnection.id, revision: awsConnection.revision, modelId: K3 }),
    endpoint: awsConnection.endpoint,
    sdk: AWS_BEDROCK_SDK,
  }));
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['azure-openai', 'bonsai', 'aws-bedrock'],
    documents: SOURCES,
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  return { azureConnection: azure.connection!.id, awsConnection };
}

/** The person's own roster: a lead on Sol, a member on the local Gaming profile at medium, a K3 helper profile. */
export async function addTeam(api: Api, projectId: string) {
  const lead = (await api<{ member: TeamMember }>(`/projects/${projectId}/team/members`, 'POST',
    { name: 'Planner', role: 'lead', engine: 'azure-openai', model: SOL })).member;
  const member = (await api<{ member: TeamMember }>(`/projects/${projectId}/team/members`, 'POST',
    { name: 'Counter', role: 'member', engine: 'bonsai', model: LOCAL_GAMING })).member;
  // Every Agent Team member runs at medium reasoning; the person sets it on the member's thread.
  await api(`/projects/${projectId}/threads/${member.threadId}`, 'PUT',
    { engine: 'bonsai', requested: { model: LOCAL_GAMING, effort: 'medium' } });
  const helperProfileId = (await api<{ profileId: string }>('/agent-profiles', 'POST',
    { name: 'Checker', engine: 'aws-bedrock', model: K3, effort: 'medium', agentId: 'auto', rules: [] })).profileId;
  return { lead, member, helperProfileId };
}
