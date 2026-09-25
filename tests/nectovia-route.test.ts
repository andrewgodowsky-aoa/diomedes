/**
 * The Nectovia route below the harness (contract `nectovia-managed/1`, sections 1 to 3): the
 * real `ai` and `@ai-sdk/openai` packages build and parse every request, and only the network
 * under them is replaced by a gateway stand-in. Nothing here reaches the account service or a
 * provider, and no provider credential exists anywhere in this file.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ToolDescriptor } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import { GPT6_LUNA, MODEL_API_PROVIDERS, MODEL_API_ROUTES, NECTOVIA_ROUTE } from '../shared/model-api.js';
import { exposureAttempt } from '../server/engines/aws-bedrock.js';
import { CONVERSATION_LIMITS, ModelApiError, WORK_LIMITS } from '../server/engines/model-api-core.js';
import {
  gatewayRefusal,
  NECTOVIA_SIGN_IN,
  NECTOVIA_UNAVAILABLE,
  nectoviaConnectionId,
  nectoviaRateCard,
  respondNectovia,
  type ManagedAdmission,
  type NectoviaPolicy,
} from '../server/engines/nectovia.js';
import { SpendExposure, usageCost } from '../server/spend-exposure.js';
import { routeEntrySchema } from '../services/control-plane/src/commercial.js';
import { responsesAnswer } from './fixtures/model-api-streams.js';

const BASE = 'https://accounts.nectovia.test';
const GATEWAY = `${BASE}/managed/v1/responses`;
const TOKEN = 'session-access-token-test-only-0123456789';
const CONNECTION = nectoviaConnectionId('org_juniper', new Date('2026-09-25T12:00:00.000Z'));
const MANAGED: ManagedAdmission = {
  admissionId: 'adm_0123456789abcdef',
  organizationId: 'org_juniper',
  policyRevision: 7,
  tier: 'efficient',
  usageClass: 'included-chat',
  rootJobId: 'model-0123456789abcdef',
};
const READ_SOURCE: ToolDescriptor = {
  name: 'read_source',
  version: '1',
  description: 'Read one admitted source.',
  effect: 'read',
  permission: null,
  approval: false,
  destination: 'local',
  trustedInputRequired: false,
  cost: 0,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};
const USAGE = {
  input_tokens: 1_200,
  input_tokens_details: { cached_tokens: 200 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 120 },
  total_tokens: 1_500,
};

type Item = Record<string, unknown>;
const reasoning = (id = 'rs_1', encrypted = 'enc-1'): Item => ({ type: 'reasoning', id, summary: [], encrypted_content: encrypted });
const message = (text: string): Item => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const functionCall = (callId: string, name: string, args: string): Item => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: args,
  status: 'completed',
});
const envelope = (output: Item[], extra: Item = {}) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: GPT6_LUNA.model,
  output,
  usage: USAGE,
  incomplete_details: null,
  error: null,
  ...extra,
});

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}
/** The gateway stand-in: records each request and answers from a script. */
function gateway(script: Array<(sent: Sent) => Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    sent.push(request);
    const next = script.shift();
    if (!next) throw new Error('No scripted answer left.');
    return next(request);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const answer = (body: unknown, status = 200) => responsesAnswer(body, status, { 'x-nectovia-attempt': 'gw-attempt-1' });
const refusal = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });

/**
 * The body contract section 1 allows, checked field by field. It returns every problem, so a
 * field the SDK sends and the contract does not list is named rather than dropped.
 */
function contractProblems(body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const allowed = new Set([
    'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning',
    'include', 'max_output_tokens', 'store', 'stream', 'text',
  ]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) problems.push(`unsupported field ${key}`);
  if (body.model !== GPT6_LUNA.model) problems.push('model');
  if (body.store !== undefined && body.store !== false) problems.push('store');
  if (body.stream !== undefined && body.stream !== true) problems.push('stream');
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false) problems.push('parallel_tool_calls');
  if (body.include !== undefined && JSON.stringify(body.include) !== JSON.stringify(['reasoning.encrypted_content']))
    problems.push('include');
  const effort = (body.reasoning as Item | undefined)?.effort;
  if (body.reasoning !== undefined && !['low', 'medium', 'high'].includes(String(effort))) problems.push('reasoning.effort');
  for (const key of Object.keys((body.reasoning as Item | undefined) ?? {}))
    if (key !== 'effort' && !(key === 'summary' && (body.reasoning as Item).summary === null)) problems.push(`reasoning.${key}`);
  const max = body.max_output_tokens;
  if (max !== undefined && (!Number.isInteger(max) || (max as number) < 1 || (max as number) > GPT6_LUNA.maxOutputTokens))
    problems.push('max_output_tokens');
  const tools = (body.tools as Item[] | undefined) ?? [];
  if (tools.length > 64) problems.push('tools: more than 64');
  for (const tool of tools) {
    if (tool.type !== 'function') problems.push(`tool type ${String(tool.type)}`);
    for (const key of Object.keys(tool))
      if (!['type', 'name', 'description', 'parameters', 'strict'].includes(key)) problems.push(`tool field ${key}`);
    if (JSON.stringify(tool).length > 16_384) problems.push('tool larger than 16 KB');
  }
  const choice = body.tool_choice;
  if (choice !== undefined && !['auto', 'none', 'required'].includes(String(choice))) {
    const named = choice as Item;
    if (named?.type !== 'function' || !tools.some((tool) => tool.name === named.name)) problems.push('tool_choice');
  }
  for (const item of (body.input as Item[]) ?? []) {
    // A message item is `{ type: 'message', role, content }`; the SDK leaves `type` out (see below).
    const type = item.type ?? (typeof item.role === 'string' ? 'message' : undefined);
    if (type === 'message') {
      if (!['developer', 'system', 'user', 'assistant'].includes(String(item.role))) problems.push(`role ${String(item.role)}`);
      const parts = typeof item.content === 'string' ? [] : ((item.content as Item[]) ?? []);
      for (const part of parts) {
        if (!['input_text', 'output_text', 'input_image'].includes(String(part.type))) problems.push(`content part ${String(part.type)}`);
        if (part.type === 'input_image' && !String(part.image_url ?? '').startsWith('data:')) problems.push('remote image');
      }
    } else if (type === 'reasoning') {
      if (typeof item.encrypted_content !== 'string') problems.push('reasoning without encrypted_content');
    } else if (type !== 'function_call' && type !== 'function_call_output') problems.push(`input item ${String(type)}`);
  }
  return problems;
}

let dir: string;
let exposure: SpendExposure;
let run = 0;
const envKey = process.env.OPENAI_API_KEY;
const policy = (tiers: Partial<NectoviaPolicy['tiers']> = {}): NectoviaPolicy => ({
  revision: 8,
  tiers: { efficient: { model: GPT6_LUNA.model, label: 'GPT-6 Luna' }, focused: null, thorough: null, ...tiers },
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-nectovia-route-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
  await exposure.setCap(CONNECTION, micro(1_000_000), { approvedBy: 'test host', note: 'local guard' });
  // Any ambient key must be ignored: this route sends only the session's bearer token.
  process.env.OPENAI_API_KEY = 'ambient-env-key-must-not-be-sent';
  run += 1;
});
afterEach(async () => {
  if (envKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = envKey;
  await fs.rm(dir, { recursive: true, force: true });
});

function call(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof respondNectovia>[0]> = {},
) {
  const messages: ModelMessage[] = overrides.messages ?? [{ role: 'user', content: 'How many loaves are on order?' }];
  return respondNectovia({
    base: BASE,
    account: { refreshPolicy: async () => policy() },
    connectionId: CONNECTION,
    model: GPT6_LUNA.model,
    managed: MANAGED,
    token: TOKEN,
    card: nectoviaRateCard(GPT6_LUNA.model),
    exposure,
    attempt: exposureAttempt(`run-${run}`, 'model@1', messages),
    instructions: 'You are Nectovia. Answer from what you were given.',
    messages,
    tools: [],
    effort: 'low',
    limits: CONVERSATION_LIMITS,
    signal: new AbortController().signal,
    transport: fetch,
    ...overrides,
  });
}
async function failure(promise: Promise<unknown>): Promise<ModelApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelApiError);
    return error as ModelApiError;
  }
  throw new Error('Expected the call to fail.');
}

describe('the route identity', () => {
  test('nectovia is a desktop model-API route and never a provider the control plane can register', () => {
    expect(MODEL_API_ROUTES).toContain(NECTOVIA_ROUTE);
    expect(MODEL_API_PROVIDERS).not.toContain(NECTOVIA_ROUTE);
    const entry = {
      v: 1,
      id: 'aws-luna-6',
      provider: 'aws-bedrock',
      model: GPT6_LUNA.model,
      label: GPT6_LUNA.label,
      region: 'us',
      processing: 'AWS Bedrock US inference profile.',
      status: 'qualified',
      evidence: 'Test entry.',
      revision: 1,
      updatedAt: '2026-09-25T12:00:00.000Z',
      updatedBy: 'staff_routing',
    };
    expect(routeEntrySchema.safeParse(entry).success).toBe(true);
    // Staff can never register the managed route as a provider, so no tier can route to itself.
    const refused = routeEntrySchema.safeParse({ ...entry, provider: NECTOVIA_ROUTE });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['provider']);
  });
});

describe('the request the real SDK sends to the gateway', () => {
  test('exact URL, the session bearer and every X-Nectovia header, no provider credential, and a body section 1 allows', async () => {
    const net = gateway([() => answer(envelope([reasoning(), message('Forty loaves are on order.')]))]);
    const result = await call(net.fetch);

    expect(result.outcome).toEqual({ kind: 'final', text: 'Forty loaves are on order.' });
    expect(net.sent).toHaveLength(1);
    const [sent] = net.sent;
    expect(sent.url).toBe(GATEWAY);
    // The attempt is the local hold's id: one per provider call, fixed before anything was sent.
    const hold = exposure.list(CONNECTION)[0];
    expect(Object.fromEntries(sent.headers.entries())).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      // The SDK's own identification; nothing in it is a credential.
      'user-agent': expect.stringMatching(/^ai-sdk\/openai\//),
      'x-nectovia-organization': 'org_juniper',
      'x-nectovia-admission': 'adm_0123456789abcdef',
      'x-nectovia-job': 'model-0123456789abcdef',
      'x-nectovia-attempt': hold.id,
      'x-nectovia-tier': 'efficient',
      'x-nectovia-usage-class': 'included-chat',
      'x-nectovia-policy-revision': '7',
    });
    expect(hold.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(JSON.stringify(sent)).not.toContain('ambient-env-key-must-not-be-sent');
    expect(JSON.stringify(sent)).not.toContain('diomedes-guarded-credential');

    // The body exactly as the SDK produced it with the AWS route's provider options. Two things
    // the contract table does not spell out and the gateway must accept: a message item has no
    // `type: 'message'`, and the developer message's content is a plain string.
    expect(contractProblems(sent.body)).toEqual([]);
    expect(sent.body).toEqual({
      model: GPT6_LUNA.model,
      input: [
        { role: 'developer', content: 'You are Nectovia. Answer from what you were given.' },
        { role: 'user', content: [{ type: 'input_text', text: 'How many loaves are on order?' }] },
      ],
      max_output_tokens: CONVERSATION_LIMITS.maxOutputTokens,
      store: false,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: false,
      reasoning: { effort: 'low' },
      stream: true,
    });

    // Settled on the local guard from the usage the gateway passed through, at the registry's price.
    const expected = usageCost(nectoviaRateCard(GPT6_LUNA.model), {
      inputTokens: 1_200,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 300,
      reasoningTokens: 120,
    }).microUsd;
    expect(result.reservation.state).toBe('settled');
    expect(result.reservation.settledMicroUsd).toBe(expected);
    expect(result.reservation.rateCardVersion).toBe('aws-bedrock-gpt-6-luna-us-2026-09-25.1');
    expect(result.providerRequestId).toBe('gw-attempt-1');
  });

  test('a tool call and its continuation stay inside the allowlist: function tools, reasoning, call and output items', async () => {
    const net = gateway([
      () => answer(envelope([reasoning('rs_1', 'enc-first'), functionCall('call_1', 'read_source', '{"path":"orders.txt"}')])),
      () => answer(envelope([reasoning('rs_2', 'enc-second'), message('Forty, per orders.txt.')], { id: 'resp_2' })),
    ]);
    const first = await call(net.fetch, { tools: [READ_SOURCE] });
    expect(first.outcome).toMatchObject({ kind: 'tool', callId: 'call_1', name: 'read_source' });
    expect(contractProblems(net.sent[0].body)).toEqual([]);
    expect(net.sent[0].body.tool_choice).toBe('auto');

    const messages: ModelMessage[] = [
      { role: 'user', content: 'How many loaves are on order?' },
      ...first.responseMessages,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'read_source',
            output: { type: 'json', value: { found: true, path: 'orders.txt', text: 'Loaves: 40' } },
          },
        ],
      },
    ];
    const second = await call(net.fetch, {
      tools: [READ_SOURCE],
      messages,
      attempt: exposureAttempt(`run-${run}`, 'model@2', messages),
    });
    expect(second.outcome).toEqual({ kind: 'final', text: 'Forty, per orders.txt.' });
    const body = net.sent[1].body;
    expect(contractProblems(body)).toEqual([]);
    const input = body.input as Item[];
    expect(input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'enc-first' }));
    expect(input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_1' }));
    expect(input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }));
    // Two provider calls, two attempts: the gateway is never told one attempt twice.
    const holds = exposure.list(CONNECTION);
    expect(net.sent.map((sent) => sent.headers.get('x-nectovia-attempt'))).toEqual(holds.map((hold) => hold.id));
    expect(new Set(holds.map((hold) => hold.id)).size).toBe(2);
  });

  test("Work's longer limits are held to Nectovia's own 16,000-token output cap", async () => {
    const net = gateway([() => answer(envelope([message('Done.')]))]);
    await call(net.fetch, { limits: WORK_LIMITS });
    expect(WORK_LIMITS.maxOutputTokens).toBeGreaterThan(GPT6_LUNA.maxOutputTokens);
    expect(net.sent[0].body.max_output_tokens).toBe(GPT6_LUNA.maxOutputTokens);
  });

  test('a model this computer has no price for is refused before anything is held or sent', async () => {
    expect(() => nectoviaRateCard('us.openai.gpt-6-sol')).toThrow(ModelApiError);
    expect(exposure.list(CONNECTION)).toEqual([]);
  });
});

describe("the gateway's refusals, in the conversation's words", () => {
  const cases: [number, string, string, string][] = [
    [401, 'sign_in_required', 'nectovia_sign_in_required', NECTOVIA_SIGN_IN],
    [403, 'agent_not_included', 'nectovia_agent_not_included', 'Juniper Street Bakery has no plan that includes the Nectovia Agent.'],
    [403, 'admission_invalid', 'nectovia_admission_invalid', 'Nectovia could not confirm this message was admitted. Nothing was charged. Send it again.'],
    [402, 'insufficient_allowance', 'nectovia_insufficient_allowance', "This business has used this month's 1,000 credits."],
    [402, 'cap_request_required', 'nectovia_cap_request_required', 'This job needs a cap request before it can spend more.'],
    [409, 'tier_unrouted', 'nectovia_tier_unrouted', 'Efficient has no Nectovia model right now. Nothing was charged. Choose another tier.'],
    [413, 'context_too_long', 'nectovia_too_long', 'This message and its sources are longer than Nectovia accepts. Nothing was charged. Choose fewer or shorter sources.'],
    [429, 'provider_busy', 'nectovia_provider_busy', "Nectovia's model service is busy. Nothing was charged. Try again in a minute."],
    [503, 'route_unavailable', 'nectovia_route_unavailable', NECTOVIA_UNAVAILABLE],
    [400, 'unsupported_field', 'nectovia_unsupported_field', 'Nectovia refused this message: The request field background is not accepted. Nothing was charged.'],
  ];
  test.each(cases)('HTTP %i %s reads as %s, with the local hold released and one request', async (status, code, mapped, words) => {
    const said =
      code === 'agent_not_included' ? 'Juniper Street Bakery has no plan that includes the Nectovia Agent.'
      : code === 'insufficient_allowance' ? "This business has used this month's 1,000 credits."
      : code === 'cap_request_required' ? 'This job needs a cap request before it can spend more.'
      : code === 'unsupported_field' ? 'The request field background is not accepted.'
      : 'Gateway words.';
    const net = gateway([() => refusal(status, code, said)]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe(mapped);
    expect(error.message).toBe(words);
    expect(error.message).not.toMatch(/\b(AWS|Bedrock|provider|connect)\b/i);
    expect(error.evidence.reservation?.state).toBe('released');
    expect(net.sent).toHaveLength(1);
  });

  test('a 409 policy_changed reads the policy again once and names the model the tier runs now', async () => {
    const refresh = vi.fn(async () => policy({ efficient: { model: GPT6_LUNA.model, label: 'GPT-6 Luna (2)' } }));
    const net = gateway([() => refusal(409, 'policy_changed', 'The published policy changed.')]);
    const error = await failure(call(net.fetch, { account: { refreshPolicy: refresh } }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('nectovia_policy_changed');
    expect(error.message).toBe('Nectovia now runs Efficient on GPT-6 Luna (2). Nothing was charged. Send your message again to use it.');
    expect(error.evidence.reservation?.state).toBe('released');
    // Nothing is retried, on this route or any other.
    expect(net.sent).toHaveLength(1);
  });

  test('a 503 without the gateway’s own body is not claimed as uncharged', () => {
    expect(gatewayRefusal(503, null, 'efficient')).toBeNull();
    expect(gatewayRefusal(502, { code: null, message: 'Bad gateway' }, 'efficient')).toBeNull();
  });
});
