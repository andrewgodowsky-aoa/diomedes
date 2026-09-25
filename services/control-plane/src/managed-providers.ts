/**
 * The managed gateway's provider registry (contract `nectovia-managed/1`, section 4).
 *
 * A reviewed code table, keyed by `(provider, region, model)`. Staff choose which
 * qualified route serves a tier; they cannot set a price, an endpoint or a
 * credential, because none of those is data: each is a line in this file, and
 * changing one is a reviewed code change.
 *
 * The credential is named here, never held here. `credentialFor` reads the
 * Worker secret the row names from the environment at call time; the value is
 * sent as a bearer to the row's endpoint and to nothing else, and it never
 * enters a log line, a response, a stored row or an error.
 *
 * Also here: the one real caller (Bedrock's OpenAI-compatible Responses
 * endpoint) and the faux cloud's scripted provider, which answers in the same
 * Responses SSE the real endpoint streams, with exact usage, so the desktop's
 * whole loop runs offline.
 */
import type { RateSnapshot } from '../../../shared/managed-usage.js';

export interface ProviderRegistryRow {
  readonly provider: 'aws-bedrock';
  readonly region: string;
  /** The exact model id the route entry names and the provider is sent. */
  readonly model: string;
  /** The one URL a call to this row may go to. */
  readonly endpoint: string;
  /** µUSD per million tokens. The reservation and the settlement price from this, and only this. */
  readonly rate: RateSnapshot;
  /** Our own product limit on output per call, not a claim about the model's maximum. */
  readonly maxOutputTokens: number;
  /** The Worker secret that holds the key. A name only. */
  readonly credential: 'BEDROCK_API_KEY';
  /** Where the provider puts its request id, for a receipt when the stream carries no response id. */
  readonly requestIdHeaders: readonly string[];
}

const row = (value: ProviderRegistryRow): ProviderRegistryRow =>
  Object.freeze({ ...value, rate: Object.freeze({ ...value.rate }), requestIdHeaders: Object.freeze([...value.requestIdHeaders]) });

/** AWS model card for OpenAI GPT-6 Luna, US Geo cross-Region profile, checked 2026-09-25. */
export const MANAGED_PROVIDERS: readonly ProviderRegistryRow[] = Object.freeze([
  row({
    provider: 'aws-bedrock',
    region: 'us',
    model: 'us.openai.gpt-6-luna',
    endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses',
    rate: {
      version: 'aws-bedrock-gpt-6-luna-us-2026-09-25.1',
      inputMicroUsdPerMillion: 110_000,
      cacheReadMicroUsdPerMillion: 11_000,
      cacheWriteMicroUsdPerMillion: 137_500,
      outputMicroUsdPerMillion: 550_000,
    },
    maxOutputTokens: 16_000,
    credential: 'BEDROCK_API_KEY',
    requestIdHeaders: ['x-amzn-requestid', 'x-request-id'],
  }),
]);

/** The registry row a route entry resolves to, or undefined: all three keys must match. */
export function registryRow(
  route: { provider: string; region: string | null; model: string },
  registry: readonly ProviderRegistryRow[] = MANAGED_PROVIDERS,
): ProviderRegistryRow | undefined {
  return registry.find((item) => item.provider === route.provider && item.region === route.region && item.model === route.model);
}

export type ProviderEnv = Readonly<Record<string, unknown>>;

/** The configured key for a row, read now, or null when it is absent or unusable. */
export function credentialFor(item: ProviderRegistryRow, env: ProviderEnv): string | null {
  const value = env[item.credential];
  return typeof value === 'string' && value.length <= 8_192 && /^[\x21-\x7e]+$/.test(value) ? value : null;
}

// --- calling a provider ---------------------------------------------------------------

export interface ProviderCall {
  row: ProviderRegistryRow;
  credential: string;
  /** The serialized request body, exactly as it is to be sent. */
  body: string;
  signal: AbortSignal;
}
export type ProviderCaller = (call: ProviderCall) => Promise<Response>;

/**
 * Bedrock's OpenAI-compatible Responses endpoint. The transport defaults to the
 * global fetch, read at call time; a redirect is returned, never followed, so the
 * key only ever goes to the registry's endpoint.
 */
export function bedrockResponsesCaller(transport?: typeof globalThis.fetch): ProviderCaller {
  return ({ row: item, credential, body, signal }) =>
    (transport ?? globalThis.fetch)(item.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body,
      signal,
      redirect: 'manual',
    });
}

// --- the faux cloud's scripted provider -------------------------------------------------

/** What the scripted model says when it is not calling a tool. */
export const SCRIPTED_ANSWER = 'This is the faux cloud’s scripted model. It answered offline; no provider was called.';

/** The usage every scripted turn reports, in the Responses API's own shape. Output never exceeds the request's cap. */
export const SCRIPTED_USAGE = Object.freeze({
  input_tokens: 900,
  input_tokens_details: Object.freeze({ cached_tokens: 100 }),
  output_tokens: 40,
  output_tokens_details: Object.freeze({ reasoning_tokens: 8 }),
  total_tokens: 940,
});

/** The placeholder the faux cloud configures as its key when the scripted provider answers. Not a secret. */
export const FAUX_SCRIPTED_CREDENTIAL = 'faux-scripted-provider';

const TOOL_MARKER = /\[\[tool:([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s+(\{[\s\S]*?\}))?\]\]/;

function lastUserText(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const last = input[input.length - 1] as Record<string, unknown> | null;
  if (!last || typeof last !== 'object' || last.role !== 'user' || (last.type !== undefined && last.type !== 'message')) return null;
  if (typeof last.content === 'string') return last.content;
  if (!Array.isArray(last.content)) return null;
  return last.content
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'input_text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

function offeredTools(tools: unknown): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(tools))
    for (const item of tools)
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'function' && typeof (item as { name?: unknown }).name === 'string')
        names.add((item as { name: string }).name);
  return names;
}

/**
 * A fetch-compatible transport that answers every Responses request with a
 * scripted stream: a reasoning item, then either a function call (when the
 * request offers tools and its last input item is a user message containing
 * `[[tool:<name>]]` or `[[tool:<name> {json arguments}]]` for an offered tool) or
 * the short answer, then `response.completed` carrying the whole response and
 * `SCRIPTED_USAGE`. Given to `bedrockResponsesCaller`, it exercises the real
 * caller end to end without a network.
 */
export function scriptedResponsesFetch(options: { now?: () => number; id?: () => string } = {}): typeof globalThis.fetch {
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID().replace(/-/g, ''));
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await request.text()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: { message: 'The scripted provider needs a JSON body.', type: 'invalid_request_error' } }, { status: 400 });
    }
    const model = typeof body.model === 'string' ? body.model : 'scripted';
    const cap = typeof body.max_output_tokens === 'number' ? body.max_output_tokens : Number.POSITIVE_INFINITY;
    const outputTokens = Math.min(SCRIPTED_USAGE.output_tokens, cap);
    const usage = {
      ...SCRIPTED_USAGE,
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: Math.min(SCRIPTED_USAGE.output_tokens_details.reasoning_tokens, outputTokens) },
      total_tokens: SCRIPTED_USAGE.input_tokens + outputTokens,
    };
    const responseId = `resp_${id()}`;
    const createdAt = Math.floor(now() / 1000);
    const encrypted = Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content');
    const reasoning = { id: `rs_${id()}`, type: 'reasoning', summary: [], encrypted_content: encrypted ? `scripted-reasoning-${id()}` : null };

    const text = lastUserText(body.input);
    const marker = text === null ? null : TOOL_MARKER.exec(text);
    const toolName = marker && offeredTools(body.tools).has(marker[1]) ? marker[1] : null;

    const events: Record<string, unknown>[] = [];
    const shell = { id: responseId, object: 'response', created_at: createdAt, model, error: null, incomplete_details: null };
    events.push({ type: 'response.created', response: { ...shell, status: 'in_progress', output: [], usage: null } });
    events.push({ type: 'response.in_progress', response: { ...shell, status: 'in_progress', output: [], usage: null } });
    events.push({ type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: null } });
    events.push({ type: 'response.output_item.done', output_index: 0, item: reasoning });
    let item: Record<string, unknown>;
    if (toolName) {
      const args = marker![2] ?? '{}';
      const callId = `call_${id()}`;
      const itemId = `fc_${id()}`;
      events.push({ type: 'response.output_item.added', output_index: 1, item: { id: itemId, type: 'function_call', status: 'in_progress', call_id: callId, name: toolName, arguments: '' } });
      events.push({ type: 'response.function_call_arguments.delta', item_id: itemId, output_index: 1, delta: args });
      events.push({ type: 'response.function_call_arguments.done', item_id: itemId, output_index: 1, arguments: args });
      item = { id: itemId, type: 'function_call', status: 'completed', call_id: callId, name: toolName, arguments: args };
    } else {
      const itemId = `msg_${id()}`;
      events.push({ type: 'response.output_item.added', output_index: 1, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      events.push({ type: 'response.content_part.added', item_id: itemId, output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (const delta of SCRIPTED_ANSWER.match(/\S+\s*/g) ?? [])
        events.push({ type: 'response.output_text.delta', item_id: itemId, output_index: 1, content_index: 0, delta });
      events.push({ type: 'response.output_text.done', item_id: itemId, output_index: 1, content_index: 0, text: SCRIPTED_ANSWER });
      const part = { type: 'output_text', text: SCRIPTED_ANSWER, annotations: [] };
      events.push({ type: 'response.content_part.done', item_id: itemId, output_index: 1, content_index: 0, part });
      item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
    }
    events.push({ type: 'response.output_item.done', output_index: 1, item });
    events.push({ type: 'response.completed', response: { ...shell, status: 'completed', output: [reasoning, item], usage } });

    const encoder = new TextEncoder();
    const frames = events.map((event, index) =>
      encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`));
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < frames.length) controller.enqueue(frames[next++]);
        else controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-amzn-requestid': id() } });
  }) as typeof globalThis.fetch;
}
