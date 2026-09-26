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
 *
 * Typed evaluations (`POST /managed/v1/evaluations`) have their own row, their
 * own caller (OpenRouter's Decisions API) and their own scripted provider, at the
 * end of this file. The same rules hold: the endpoint, the price and the
 * credential's name are reviewed lines, never data.
 */
import type { EvaluationRequest, ProviderQuestion } from '../../../shared/evaluation-wire.js';
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

/** Every Worker secret a row may name. Each is set by the owner and read at call time. */
export type ProviderCredential = 'BEDROCK_API_KEY' | 'OPENROUTER_API_KEY';

/** The configured key for a row, read now, or null when it is absent or unusable. */
export function credentialFor(item: { readonly credential: ProviderCredential }, env: ProviderEnv): string | null {
  const value = env[item.credential];
  return typeof value === 'string' && value.length <= 8_192 && /^[\x21-\x7e]+$/.test(value) ? value : null;
}

/**
 * Which rule a row's key breaks, for the Worker's log, or null when `credentialFor`
 * would accept it. A rule name only, never the value: the owner reads it to fix a
 * secret nobody can read back.
 */
export function credentialProblem(item: { readonly credential: ProviderCredential }, env: ProviderEnv): 'missing' | 'whitespace' | 'format' | null {
  const value = env[item.credential];
  if (typeof value !== 'string' || !value) return 'missing';
  if (value !== value.trim() || /[\r\n\0]/.test(value)) return 'whitespace';
  if (credentialFor(item, env) === null) return 'format';
  return null;
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

// --- typed evaluations ------------------------------------------------------------------

/**
 * A route the gateway sends a typed evaluation to (`POST /managed/v1/evaluations`).
 * Reviewed like the rows above: nothing in it is data.
 */
export interface EvaluationProviderRow {
  /** The route id every hold for it is recorded under. */
  readonly id: string;
  readonly provider: 'openrouter';
  /**
   * The model id sent. The provider may answer under a dated snapshot of it
   * (`<model>-YYYYMMDD`), which is the same model at the same price.
   */
  readonly model: string;
  /** The one URL a call to this row may go to. */
  readonly endpoint: string;
  /**
   * µUSD per million tokens, under the version the desktop prices this model with
   * (server/harness/evaluation-price.ts, EVALUATION_PRICE_JEV_113_OPENROUTER). The
   * route reports no cache tokens; if it ever did, they would cost what input does.
   */
  readonly rate: RateSnapshot;
  /** The Worker secret that holds the key. A name only. */
  readonly credential: 'OPENROUTER_API_KEY';
  /** Where the provider puts a request id, kept as the evidence on a released refusal. */
  readonly requestIdHeaders: readonly string[];
}

/**
 * Jev 1.13 on OpenRouter's Decisions API, as OpenRouter lists it on 2026-09-26:
 * one endpoint (TypeSafe), 32,000 tokens of context, $0.000000042 per prompt
 * token and nothing per completion token.
 */
export const EVALUATION_PROVIDER: EvaluationProviderRow = Object.freeze<EvaluationProviderRow>({
  id: 'openrouter-jev-1.13',
  provider: 'openrouter',
  model: 'typesafe/jev-1.13',
  endpoint: 'https://openrouter.ai/api/alpha/decisions',
  rate: Object.freeze({
    version: 'evaluation-price-2026-09-22.openrouter.1',
    inputMicroUsdPerMillion: 42_000,
    cacheReadMicroUsdPerMillion: 42_000,
    cacheWriteMicroUsdPerMillion: 42_000,
    outputMicroUsdPerMillion: 0,
  }),
  credential: 'OPENROUTER_API_KEY',
  requestIdHeaders: Object.freeze(['x-request-id', 'cf-ray']),
});

export interface EvaluationProviderCall {
  row: EvaluationProviderRow;
  credential: string;
  /** The serialized request body, exactly as it is to be sent. */
  body: string;
  signal: AbortSignal;
}
export type EvaluationProviderCaller = (call: EvaluationProviderCall) => Promise<Response>;

/**
 * OpenRouter's Decisions endpoint, called once. Nothing here retries (the AI
 * SDK's default of two retries would make one refusal three calls); the key is
 * the one passed in, never an ambient variable; and a redirect is returned, never
 * followed, so the key only ever goes to the registry's endpoint. The transport
 * defaults to the global fetch, read at call time.
 */
export function openRouterDecisionsCaller(transport?: typeof globalThis.fetch): EvaluationProviderCaller {
  return ({ row: item, credential, body, signal }) =>
    (transport ?? globalThis.fetch)(item.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal,
      redirect: 'manual',
    });
}

/**
 * Private processing by default (Pillar 09): every evaluation goes only to
 * providers that don't collect data. Never `zdr`: OpenRouter lists no
 * zero-retention endpoint for this model, so a ZDR-only request would find none.
 * When no endpoint meets the policy, the call is refused, never sent elsewhere.
 */
export const DECISIONS_DATA_POLICY = Object.freeze({ data_collection: 'deny' as const });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A question in the Decisions API's shape: a yes-or-no question is a `noul`, described on both sides or neither. */
function decisionsQuestion(question: ProviderQuestion): Record<string, unknown> {
  if (question.type !== 'boolean') return question;
  return question.criteria
    ? { type: 'noul', instructions: question.instructions, criteria: { true: question.criteria.true, false: question.criteria.false } }
    : { type: 'noul', instructions: question.instructions };
}

/** What is sent for a checked evaluation: the row's model, the state, the questions and the data policy. Nothing else. */
export function decisionsBody(item: EvaluationProviderRow, request: EvaluationRequest): string {
  return JSON.stringify({
    model: item.model,
    state: request.state,
    questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, decisionsQuestion(question)])),
    provider: DECISIONS_DATA_POLICY,
  });
}

/**
 * Decisions usage in the `nectovia-usage/1` counts. The API reports no cache or
 * reasoning tokens, so those parts are none; a count it leaves out stays out, and
 * the settlement then holds the charge as uncertain.
 */
export function decisionsUsage(usage: Record<string, unknown>) {
  return { inputTokens: usage.input_tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: usage.output_tokens, reasoningTokens: 0 };
}

/** Whether the model the provider says answered is the row's: itself, or a dated snapshot of it. */
export function answeredAs(item: EvaluationProviderRow, model: string): boolean {
  return model === item.model || (model.startsWith(`${item.model}-`) && /^\d{8}$/.test(model.slice(item.model.length + 1)));
}

/** Decisions answers are rounded to two decimals, as the installed OpenRouter provider declares. */
export const DECISIONS_ROUNDING = Object.freeze({ probabilityDecimals: 2, scoreDecimals: 2 });

function evaluationAnswer(answer: unknown): unknown {
  if (!isRecord(answer)) return answer;
  const probabilities = answer.probabilities === undefined ? {} : { probabilities: answer.probabilities };
  if (answer.type === 'noul') return { type: 'boolean', probability: answer.noul };
  if (answer.type === 'choice') return { type: 'choice', choice: answer.choice, ...probabilities };
  if (answer.type === 'score') return { type: 'score', score: answer.score, ...probabilities };
  return answer;
}

/**
 * A Decisions answer in the reply shape the desktop validates
 * (shared/evaluation.ts, the same shape the installed provider produces): a
 * `noul` becomes a yes-or-no question's P(true), confidence and legends are
 * dropped, and the answering model and id are named only when the provider
 * named them. `answers` must already be an object.
 */
export function evaluationReply(answer: Record<string, unknown>): Record<string, unknown> {
  const answers = answer.answers as Record<string, unknown>;
  const usage = isRecord(answer.usage) ? answer.usage : null;
  return {
    answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, evaluationAnswer(value)])),
    ...(usage ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}),
    rounding: DECISIONS_ROUNDING,
    warnings: [],
    response: {
      ...(typeof answer.model === 'string' ? { modelId: answer.model } : {}),
      ...(typeof answer.id === 'string' ? { id: answer.id } : {}),
    },
  };
}

/** The date the scripted Decisions provider reports its model under: a snapshot, as the real API names one. */
export const SCRIPTED_DECISIONS_SNAPSHOT = '20260917';

/**
 * A fetch-compatible transport that answers every Decisions request from the
 * request itself: each choice takes its first option, each score its lowest
 * level and each yes-or-no question 0.1, all with certainty, under a dated
 * snapshot of the model asked for, with the usage the real API reports (input
 * and output tokens, and their cost at the row's price). Given to
 * `openRouterDecisionsCaller`, it runs the whole evaluation path offline.
 */
export function scriptedDecisionsFetch(options: { id?: () => string } = {}): typeof globalThis.fetch {
  const id = options.id ?? (() => crypto.randomUUID().replace(/-/g, ''));
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) throw new TypeError('not an object');
      body = value;
    } catch {
      return Response.json({ error: { code: 400, message: 'The scripted provider needs a JSON body.' } }, { status: 400 });
    }
    const questions = isRecord(body.questions) ? body.questions : {};
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      if (isRecord(question) && question.type === 'choice') {
        const first = Object.keys(isRecord(question.criteria) ? question.criteria : {})[0] ?? '';
        answers[key] = { type: 'choice', choice: first, probabilities: { [first]: 1 }, confidence: 1 };
      } else if (isRecord(question) && question.type === 'score') answers[key] = { type: 'score', score: 0, probabilities: { 0: 1 }, confidence: 1 };
      else answers[key] = { type: 'noul', noul: 0.1 };
    }
    const inputTokens = Math.ceil(new TextEncoder().encode(text).byteLength / 4);
    const outputTokens = Object.keys(questions).length;
    const rate = EVALUATION_PROVIDER.rate;
    return Response.json({
      id: `gen-${id()}`,
      model: `${typeof body.model === 'string' ? body.model : 'scripted'}-${SCRIPTED_DECISIONS_SNAPSHOT}`,
      provider: 'Scripted',
      answers,
      // USD, as OpenRouter reports it: tokens at µUSD per million, over 10^12.
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cost: (inputTokens * rate.inputMicroUsdPerMillion + outputTokens * rate.outputMicroUsdPerMillion) / 1e12 },
    }, { headers: { 'x-request-id': `req-${id()}` } });
  }) as typeof globalThis.fetch;
}
