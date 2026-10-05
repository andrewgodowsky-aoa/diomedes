/**
 * The faux cloud's side of the gateway route checks (DIO-217): the two approved company
 * connections the checks run on, shaped exactly as the deployed MANAGED_CONNECTIONS has them, a
 * Kimi K3 route on AWS and a GPT-6.1 Sol route on Azure to check, and a scripted provider that
 * answers the checks offline in each route's own protocol: Chat Completions chunks shaped like
 * K3's on Bedrock, and a Responses stream shaped like Sol's on Azure.
 *
 * The scripted provider reads each request's own bytes, as a provider would:
 *   - a request offering lookup_fact with no tool result in it asks for the tool, key alpha;
 *   - a request carrying the tool's result answers with the value the result holds;
 *   - the output-bound question reasons until its output limit and stops there;
 *   - anything else answers OK.
 * Every answer reports usage. Input is counted at four bytes a token. A system prompt (the
 * instructions) of at least 1,024 tokens that this provider has already seen for the same model is
 * read from its cache, so the second identical cache check call reads it, and so does every later
 * one sent to the same faux cloud.
 *
 * It refuses a path no approved connection serves, a request without the connection's own key
 * header, and a request that would follow a redirect. Nothing here reaches a network.
 */
import { AWS_KIMI_K3 } from '../../../../shared/model-api.js';
import type { ModelBinding, ProviderConnection } from '../../../../shared/routing-policy.js';
import { LOOKUP_FACT_TOOL, TOOL_KEY } from '../../../../shared/route-qualification-plan.js';
import type { RouteEntry } from '../commercial.js';
import { FAUX_SCRIPTED_CREDENTIAL } from '../managed-providers.js';

type Item = Record<string, unknown>;
const isObject = (value: unknown): value is Item => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const encoder = new TextEncoder();

// --- the approved connections ---------------------------------------------------------

/** Azure AI Foundry, as the deployed MANAGED_CONNECTIONS approves it (wrangler.jsonc). */
export const FAUX_AZURE_CONNECTION: ProviderConnection = Object.freeze({
  id: 'azure-foundry-dev',
  revision: 1,
  label: 'Azure AI Foundry (diomedes-foundry-dev-rg)',
  secretRef: 'AZURE_OPENAI_API_KEY',
  payer: 'company',
  account: 'Azure resource diomedes-foundry-dev-rg, project diomedes-dev',
  enabled: true,
  provider: 'azure-openai',
  resource: 'diomedes-foundry-dev-rg',
  apiVersion: 'v1',
  host: 'services.ai.azure.com',
  deployments: ['gpt-6.1-sol', 'gpt-6-luna', 'claude-opus-5-5'],
});

/** Amazon Bedrock in us-east-1, as the deployed MANAGED_CONNECTIONS approves it: Kimi K3 over Chat Completions only. */
export const FAUX_AWS_CONNECTION: ProviderConnection = Object.freeze({
  id: 'aws-bedrock-us-east-1',
  revision: 1,
  label: 'Amazon Bedrock (us-east-1)',
  secretRef: 'BEDROCK_API_KEY',
  payer: 'company',
  account: 'Diomedes Systems AWS account',
  enabled: true,
  provider: 'aws-bedrock',
  region: 'us-east-1',
  endpointFamily: 'runtime',
  allowedProfiles: ['us.moonshotai.kimi-k3'],
  modelProtocols: { 'us.moonshotai.kimi-k3': ['chat-completions'] },
});

export const FAUX_ROUTE_CHECK_CONNECTIONS: readonly ProviderConnection[] = Object.freeze([FAUX_AZURE_CONNECTION, FAUX_AWS_CONNECTION]);

/**
 * What the faux cloud adds to the gateway's environment when it is given no connections of its
 * own: the two connections, and the faux placeholder as the Azure key. The faux cloud already
 * sets the same placeholder as BEDROCK_API_KEY. Neither is a secret.
 */
export function fauxRouteCheckEnvironment(): Record<string, string> {
  return { MANAGED_CONNECTIONS: JSON.stringify(FAUX_ROUTE_CHECK_CONNECTIONS), AZURE_OPENAI_API_KEY: FAUX_SCRIPTED_CREDENTIAL };
}

// --- the routes to check ----------------------------------------------------------------

/** A route save request with its binding, as staff send it to POST /ops/routes. */
export type FauxRouteInput = Omit<RouteEntry, 'v' | 'revision' | 'updatedAt' | 'updatedBy' | 'binding'> & { binding: ModelBinding };

const DAY_MS = 86_400_000;
const later = (at: string, days: number) => new Date(Date.parse(at) + days * DAY_MS).toISOString();

/**
 * Kimi K3 on AWS and GPT-6.1 Sol on Azure, unqualified, with no access, privacy or qualification
 * evidence and their health unverified, so no tier can resolve to either. Seeded into a new faux
 * store when both connections are approved there; tests save them the same way.
 */
export function fauxRouteCheckRoutes(at: string): FauxRouteInput[] {
  const health = { state: 'unverified' as const, observedAt: at, validUntil: later(at, 30), cooldownUntil: null, reason: 'No route check has run on this route yet.' };
  const rates = AWS_KIMI_K3.rates;
  return [
    {
      id: 'aws-kimi-k3',
      provider: 'aws-bedrock',
      model: AWS_KIMI_K3.model,
      label: AWS_KIMI_K3.label,
      region: 'us',
      processing: 'Amazon Bedrock US Geo inference profile on the company AWS account. In the faux cloud a scripted provider answers instead.',
      status: 'unqualified',
      evidence: 'Faux seed: no route check has run on this route yet.',
      binding: {
        connectionId: FAUX_AWS_CONNECTION.id,
        connectionRevision: FAUX_AWS_CONNECTION.revision,
        protocol: 'chat-completions',
        deployment: null,
        modelVersion: AWS_KIMI_K3.model,
        upstreamEndpoint: null,
        capabilities: { contextTokens: 262_144, outputTokens: 16_000, tools: true, images: false, reasoning: true },
        qualification: null,
        access: null,
        privacy: null,
        health,
        price: {
          version: 'faux-aws-bedrock-kimi-k3-us-2026-10-01.1',
          observedAt: at,
          validUntil: later(at, 365),
          evidence: 'Faux seed: the AWS Bedrock Kimi K3 US Geo Standard prices checked 2026-10-01.',
          inputMicroUsdPerMillion: rates.input,
          outputMicroUsdPerMillion: rates.output,
          reasoningMicroUsdPerMillion: rates.output,
          cacheReadMicroUsdPerMillion: rates.cacheRead,
          cacheWriteMicroUsdPerMillion: rates.cacheWrite,
          requestFeeMicroUsd: 0,
          longContext: [],
        },
      },
    },
    {
      id: 'azure-sol-6-1',
      provider: 'azure-openai',
      model: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      region: null,
      processing: 'Azure AI Foundry deployment on the company subscription. In the faux cloud a scripted provider answers instead.',
      status: 'unqualified',
      evidence: 'Faux seed: no route check has run on this route yet.',
      binding: {
        connectionId: FAUX_AZURE_CONNECTION.id,
        connectionRevision: FAUX_AZURE_CONNECTION.revision,
        protocol: 'responses',
        deployment: 'gpt-6.1-sol',
        modelVersion: 'gpt-6.1-sol',
        upstreamEndpoint: null,
        capabilities: { contextTokens: 400_000, outputTokens: 16_000, tools: true, images: true, reasoning: true },
        qualification: null,
        access: null,
        privacy: null,
        health,
        price: {
          version: 'faux-azure-gpt-6.1-sol-2026-10-05.1',
          observedAt: at,
          validUntil: later(at, 365),
          evidence: 'Faux seed: placeholder prices for local testing only.',
          inputMicroUsdPerMillion: 1_250_000,
          outputMicroUsdPerMillion: 10_000_000,
          reasoningMicroUsdPerMillion: 10_000_000,
          cacheReadMicroUsdPerMillion: 125_000,
          cacheWriteMicroUsdPerMillion: 1_250_000,
          requestFeeMicroUsd: 0,
          longContext: [],
        },
      },
    },
  ];
}

// --- the scripted provider ----------------------------------------------------------------

/** One scripted answer, in counts and parts the two stream shapes share. */
export interface ScriptedAnswer {
  /** The model the answer says served it. */
  model: string;
  /** The visible answer, when there is one. */
  text?: string;
  /** A call of lookup_fact, with its id and its arguments as sent. */
  tool?: { callId: string; arguments: string };
  /** The answer stopped at its output limit. */
  incomplete?: boolean;
  /** What the answer reports it used. Null: the stream reports no usage at all. */
  usage: { input: number; cacheRead: number; output: number; reasoning: number } | null;
}

/** Which check call a request is, read from its own bytes. */
export type RouteCheckCall = 'short-answer' | 'output-bound' | 'tool-ask' | 'tool-answer' | 'cache';

export interface ScriptedRouteChecksOptions {
  now?: () => number;
  id?: () => string;
  /** Billed output the output-bound call reports. Default: its own output limit, which keeps it bounded. */
  outputBoundTokens?: number;
  /** Answer one call some other way; undefined answers it as scripted. Tests only. */
  intercept?: (call: { kind: RouteCheckCall; protocol: 'chat-completions' | 'responses'; url: string; body: Item; headers: Headers }) =>
    Response | undefined | Promise<Response | undefined>;
}

const CACHE_MINIMUM_TOKENS = 1_024;
const tokens = (value: string) => Math.ceil(encoder.encode(value).byteLength / 4);
const refusal = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { message, type: 'invalid_request_error' } }, { status, headers });

const sse = (frames: string[], headers: Record<string, string>) =>
  new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

/** An answer as Chat Completions chunks, shaped like Kimi K3's on Bedrock: thinking first, usage last. */
export function chatCompletionsStream(answer: ScriptedAnswer, options: { id: string; created: number; headers?: Record<string, string> }): Response {
  const chunk = (delta: Item, finish: string | null = null) => ({
    id: options.id, object: 'chat.completion.chunk', created: options.created, model: answer.model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });
  const chunks: Item[] = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning_content: 'Reading the request.' })];
  if (answer.tool) {
    chunks.push(chunk({ tool_calls: [{ index: 0, id: answer.tool.callId, type: 'function', function: { name: LOOKUP_FACT_TOOL.name, arguments: '' } }] }));
    const half = Math.ceil(answer.tool.arguments.length / 2);
    for (const part of [answer.tool.arguments.slice(0, half), answer.tool.arguments.slice(half)])
      if (part) chunks.push(chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
  }
  if (answer.text) chunks.push(chunk({ content: answer.text }));
  chunks.push(chunk({}, answer.tool ? 'tool_calls' : answer.incomplete ? 'length' : 'stop'));
  if (answer.usage)
    chunks.push({
      id: options.id, object: 'chat.completion.chunk', created: options.created, model: answer.model, choices: [],
      usage: {
        prompt_tokens: answer.usage.input,
        completion_tokens: answer.usage.output,
        total_tokens: answer.usage.input + answer.usage.output,
        prompt_tokens_details: { cached_tokens: answer.usage.cacheRead },
        completion_tokens_details: { reasoning_tokens: answer.usage.reasoning },
      },
    });
  return sse([...chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`), 'data: [DONE]\n\n'], options.headers ?? {});
}

/** An answer as a Responses stream, shaped like GPT-6.1 Sol's on Azure: a reasoning item, then the answer or the call. */
export function responsesStream(answer: ScriptedAnswer, options: { id: string; created: number; itemId: string; headers?: Record<string, string> }): Response {
  const shell = { id: options.id, object: 'response', created_at: options.created, model: answer.model, error: null, incomplete_details: null };
  const reasoning = { id: `rs_${options.itemId}`, type: 'reasoning', summary: [] };
  const output: Item[] = [reasoning];
  const events: Item[] = [
    { type: 'response.created', response: { ...shell, status: 'in_progress', output: [], usage: null } },
    { type: 'response.in_progress', response: { ...shell, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
  ];
  if (answer.tool) {
    const id = `fc_${options.itemId}`;
    const call = { id, type: 'function_call', status: 'completed', call_id: answer.tool.callId, name: LOOKUP_FACT_TOOL.name, arguments: answer.tool.arguments };
    events.push(
      { type: 'response.output_item.added', output_index: 1, item: { ...call, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: id, output_index: 1, delta: answer.tool.arguments },
      { type: 'response.function_call_arguments.done', item_id: id, output_index: 1, arguments: answer.tool.arguments },
      { type: 'response.output_item.done', output_index: 1, item: call },
    );
    output.push(call);
  } else if (answer.text) {
    const id = `msg_${options.itemId}`;
    const part = { type: 'output_text', text: answer.text, annotations: [] };
    const message = { id, type: 'message', role: 'assistant', status: answer.incomplete ? 'incomplete' : 'completed', content: [part] };
    events.push(
      { type: 'response.output_item.added', output_index: 1, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: id, output_index: 1, content_index: 0, part: { ...part, text: '' } },
      { type: 'response.output_text.delta', item_id: id, output_index: 1, content_index: 0, delta: answer.text },
      { type: 'response.output_text.done', item_id: id, output_index: 1, content_index: 0, text: answer.text },
      { type: 'response.content_part.done', item_id: id, output_index: 1, content_index: 0, part },
      { type: 'response.output_item.done', output_index: 1, item: message },
    );
    output.push(message);
  }
  const usage = answer.usage
    ? {
        input_tokens: answer.usage.input,
        input_tokens_details: { cached_tokens: answer.usage.cacheRead },
        output_tokens: answer.usage.output,
        output_tokens_details: { reasoning_tokens: answer.usage.reasoning },
        total_tokens: answer.usage.input + answer.usage.output,
      }
    : null;
  events.push(answer.incomplete
    ? { type: 'response.incomplete', response: { ...shell, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output, usage } }
    : { type: 'response.completed', response: { ...shell, status: 'completed', output, usage } });
  return sse(events.map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`), options.headers ?? {});
}

/** The texts of one request, in either protocol. */
function readRequest(protocol: 'chat-completions' | 'responses', body: Item) {
  if (protocol === 'chat-completions') {
    const messages = list(body.messages).filter(isObject);
    const content = (message: Item) => typeof message.content === 'string' ? message.content
      : list(message.content).filter(isObject).map((part) => text(part.text)).join('');
    return {
      system: messages.filter((message) => message.role === 'system').map(content).join('\n'),
      user: messages.filter((message) => message.role === 'user').map(content).join('\n'),
      toolResult: messages.find((message) => message.role === 'tool') ?? null,
      tools: list(body.tools).filter(isObject).map((tool) => text(isObject(tool.function) ? tool.function.name : undefined)),
      limit: typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : Number.POSITIVE_INFINITY,
    };
  }
  const items = list(body.input).filter(isObject);
  const content = (item: Item) => typeof item.content === 'string' ? item.content
    : list(item.content).filter(isObject).map((part) => text(part.text)).join('');
  return {
    system: text(body.instructions),
    user: items.filter((item) => item.role === 'user').map(content).join('\n'),
    toolResult: items.find((item) => item.type === 'function_call_output') ?? null,
    tools: list(body.tools).filter(isObject).map((tool) => text(tool.name)),
    limit: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : Number.POSITIVE_INFINITY,
  };
}

/** The value a tool result carries, read the way the check sends it: `{"value": ...}`. */
function toolValue(result: Item): string {
  const raw = typeof result.content === 'string' ? result.content : typeof result.output === 'string' ? result.output : '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed) && typeof parsed.value === 'string') return parsed.value;
  } catch {
    // A tool result that is not JSON is answered as it came.
  }
  return raw;
}

/**
 * A fetch-compatible transport that answers the route checks' requests offline, for the paths the
 * approved Bedrock and Azure connections reach: `/openai/v1/chat/completions` on a Bedrock runtime
 * host and `/openai/v1/responses` or `/openai/v1/chat/completions` on an Azure host.
 */
export function scriptedRouteChecksFetch(options: ScriptedRouteChecksOptions = {}): typeof globalThis.fetch {
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID().replace(/-/g, ''));
  /** Prefixes already read once, per model: the next identical one reads them from the cache. */
  const cached = new Set<string>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.redirect !== 'manual') throw new TypeError('The scripted provider is only ever called with redirects refused.');
    const url = new URL(request.url);
    const aws = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname);
    const azure = url.hostname.endsWith('.azure.com');
    const protocol = url.pathname === '/openai/v1/chat/completions' ? 'chat-completions' as const
      : url.pathname === '/openai/v1/responses' && azure ? 'responses' as const : null;
    if ((!aws && !azure) || !protocol) return refusal(404, 'The scripted route check provider does not serve this path.');
    const requestId = id();
    const headers: Record<string, string> = aws ? { 'x-amzn-requestid': requestId } : { 'apim-request-id': requestId, 'x-request-id': requestId };
    const keyed = aws ? /^Bearer \S+$/.test(request.headers.get('authorization') ?? '') : (request.headers.get('api-key') ?? '') !== '';
    if (!keyed) return refusal(401, 'The request carried no key.', headers);
    let body: Item;
    try {
      const parsed: unknown = JSON.parse(await request.text());
      if (!isObject(parsed)) throw new TypeError('not an object');
      body = parsed;
    } catch {
      return refusal(400, 'The scripted provider needs a JSON body.', headers);
    }
    const seen = readRequest(protocol, body);
    const kind: RouteCheckCall = seen.toolResult ? 'tool-answer'
      : seen.tools.includes(LOOKUP_FACT_TOOL.name) ? 'tool-ask'
        : seen.user.includes('9699690') ? 'output-bound'
          : tokens(seen.system) >= CACHE_MINIMUM_TOKENS ? 'cache' : 'short-answer';
    const intercepted = await options.intercept?.({ kind, protocol, url: request.url, body, headers: request.headers });
    if (intercepted) return intercepted;

    const model = text(body.model) || 'scripted';
    const prefix = tokens(seen.system);
    const key = `${model}\0${seen.system}`;
    const cacheRead = prefix >= CACHE_MINIMUM_TOKENS && cached.has(key) ? Math.floor(prefix / 128) * 128 : 0;
    if (prefix >= CACHE_MINIMUM_TOKENS) cached.add(key);
    const inputTokens = Math.max(tokens(JSON.stringify(body)), cacheRead);
    const capped = (output: number, reasoning: number) => {
      const out = Math.min(output, seen.limit);
      return { input: inputTokens, cacheRead, output: out, reasoning: Math.min(reasoning, out) };
    };
    let answer: ScriptedAnswer;
    if (kind === 'tool-ask')
      answer = { model, tool: { callId: protocol === 'chat-completions' ? 'functions.lookup_fact:0' : `call_${id()}`, arguments: JSON.stringify({ key: TOOL_KEY }) }, usage: capped(26, 12) };
    else if (kind === 'tool-answer') answer = { model, text: toolValue(seen.toolResult!), usage: capped(16, 8) };
    else if (kind === 'output-bound') {
      const output = options.outputBoundTokens ?? (Number.isFinite(seen.limit) ? seen.limit : 64);
      answer = { model, incomplete: true, usage: { input: inputTokens, cacheRead, output, reasoning: Math.max(0, output - 6) },
        ...(protocol === 'chat-completions' ? { text: 'The prime factors of 9699690 are 2, 3, 5,' } : {}) };
    } else answer = { model, text: 'OK', usage: capped(18, 14) };
    const created = Math.floor(now() / 1000);
    return protocol === 'chat-completions'
      ? chatCompletionsStream(answer, { id: `chatcmpl-${id()}`, created, headers })
      : responsesStream(answer, { id: `resp_${id()}`, created, itemId: id(), headers });
  }) as typeof globalThis.fetch;
}
