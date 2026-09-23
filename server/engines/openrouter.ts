/**
 * The direct OpenRouter route: the company's own OpenRouter account and
 * credits, reached through the chat-completions endpoint with its API key.
 *
 * OpenRouter is a router, so this route's job is to stop it routing anywhere
 * the owner did not choose:
 *   - only models on the connection's explicit allow-list are sent, never
 *     `openrouter/auto` and never a `:variant` suffix that changes routing,
 *     tools or price;
 *   - each model names the upstream endpoints it may run on (`provider.only`),
 *     with `allow_fallbacks: false`, `require_parameters: true` (an endpoint
 *     that cannot honour the tools or limits is not used) and
 *     `data_collection: 'deny'`;
 *   - no `models` fallback list, no `route`, no plugins, no provider keys
 *     (BYOK moves the bill to another payer);
 *   - the answer is refused if OpenRouter reports another model, an endpoint
 *     outside the list, or a BYOK charge.
 * Each rule is checked twice: in the SDK settings, and again in the serialized
 * body just before it leaves. Everything else is the shared model-API core.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ToolDescriptor } from '../../shared/harness.js';
import { digest } from '../harness/policy.js';
import type { ExposureAttempt, ModelRateCard, ProviderUsage, SpendExposure } from '../spend-exposure.js';
import { ConnectionFile } from './connection-file.js';
import {
  bounded,
  consistentUsage,
  CREDENTIAL_PLACEHOLDER,
  declaredRateCard,
  declaredRatesSchema,
  ModelApiError,
  respondStream,
  str,
  type ClassifiedEnvelope,
  type RespondLimits,
  type RespondResult,
  type RouteBinding,
  type StreamEnvelope,
  type StreamSinks,
} from './model-api-core.js';

export const OPENROUTER_ROUTE = 'openrouter' as const;
/** The exact dependency set this route was written and tested against. */
export const OPENROUTER_SDK = 'ai@7.0.107+@openrouter/ai-sdk-provider@3.1.0';
export const OPENROUTER_PROTOCOL = 'openai-chat-completions';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1' as const;
export const OPENROUTER_CONNECTION_ID = 'openrouter-1';

/** `vendor/model`, no `:variant`: a suffix such as `:free`, `:online` or `:nitro` changes terms or routing. */
export const OPENROUTER_MODEL = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/;
/** An upstream endpoint slug as `provider.only` takes it, e.g. `openai`, `azure`, `amazon-bedrock`. */
export const OPENROUTER_UPSTREAM = /^[a-z0-9][a-z0-9.-]{0,63}$/;

// --- the connection record ------------------------------------------------------

const iso = z.string().datetime({ offset: true });
export const openRouterModelSchema = z.strictObject({
  id: z
    .string()
    .regex(OPENROUTER_MODEL)
    .refine((id) => !id.startsWith('openrouter/'), 'OpenRouter’s own routers choose the model; name the model itself.'),
  /** The only upstream endpoints this model may run on. Never empty: an empty list means "any". */
  upstreams: z.array(z.string().regex(OPENROUTER_UPSTREAM)).min(1).max(8),
  rates: declaredRatesSchema,
});
export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

export const openRouterConnectionSchema = z
  .strictObject({
    v: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    baseUrl: z.literal(OPENROUTER_BASE_URL),
    models: z.array(openRouterModelSchema).min(1).max(16),
    /** Fixed: prompts are never sent to an endpoint that may store or train on them. */
    dataCollection: z.literal('deny'),
    /** Fixed: a model's endpoint list is never widened by OpenRouter on its own. */
    allowFallbacks: z.literal(false),
    credential: z.strictObject({
      kind: z.literal('openrouter-api-key'),
      fingerprint: z.string().regex(/^[a-f0-9]{12}$/),
      savedAt: iso,
      expiresAt: iso.nullable(),
    }),
    revision: z.number().int().min(1),
    createdAt: iso,
    updatedAt: iso,
  })
  .superRefine((value, context) => {
    if (new Set(value.models.map((model) => model.id)).size !== value.models.length)
      context.addIssue({ code: 'custom', path: ['models'], message: 'Each model appears once.' });
  });
export type OpenRouterConnection = z.infer<typeof openRouterConnectionSchema>;

export const openRouterAccountRoute = (connection: Pick<OpenRouterConnection, 'id' | 'revision'>) =>
  `${OPENROUTER_ROUTE}:${connection.id}@r${connection.revision}`;

export class OpenRouterConnections extends ConnectionFile<typeof openRouterConnectionSchema> {
  constructor(dataDir: string) {
    super(dataDir, OPENROUTER_ROUTE, openRouterConnectionSchema, 'OpenRouter');
  }
}

/** The allow-listed entry for one model, or a refusal: nothing off the list is ever sent. */
export function openRouterModelFor(connection: OpenRouterConnection, model: string): OpenRouterModel {
  const entry = connection.models.find((candidate) => candidate.id === model);
  if (!entry)
    throw new ModelApiError(
      'openrouter_unknown_model',
      `${model} is not on this OpenRouter connection’s allowed models. Nothing was sent.`,
      false,
    );
  return entry;
}

/** The owner-declared price of one allowed model, versioned by the connection generation. */
export function openRouterRateCard(connection: OpenRouterConnection, model: string): ModelRateCard {
  const entry = openRouterModelFor(connection, model);
  return declaredRateCard(
    OPENROUTER_ROUTE,
    entry.id,
    entry.rates,
    `${OPENROUTER_ROUTE}:${entry.id}@r${connection.revision}:${digest(entry.rates).slice(0, 12)}`,
  );
}

/** The provider preferences every request carries, exactly. */
export function openRouterPreferences(entry: OpenRouterModel) {
  return {
    only: [...entry.upstreams],
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: 'deny' as const,
  };
}

// --- classification ---------------------------------------------------------------

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const chatUsageSchema = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count.nullish(), cache_write_tokens: count.nullish() }).nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish(),
  is_byok: z.boolean().nullish(),
});

/** Chat-completions usage in the ledger's structure. */
export function chatUsage(raw: unknown): { usage: ProviderUsage | null; byok: boolean } {
  const parsed = chatUsageSchema.safeParse(raw);
  if (!parsed.success) return { usage: null, byok: false };
  return {
    byok: parsed.data.is_byok === true,
    usage: consistentUsage({
      inputTokens: parsed.data.prompt_tokens,
      cacheReadTokens: parsed.data.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: parsed.data.prompt_tokens_details?.cache_write_tokens ?? 0,
      outputTokens: parsed.data.completion_tokens,
      reasoningTokens: parsed.data.completion_tokens_details?.reasoning_tokens ?? 0,
    }),
  };
}

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Reads an OpenRouter stream as data: content joins, each tool call is folded
 * by its index, the last finish reason and the usage chunk decide the rest. A
 * plain JSON body is an error answer.
 */
export function classifyChat(envelope: StreamEnvelope): { readable: boolean; classified: ClassifiedEnvelope | null } {
  const result: ClassifiedEnvelope = {
    status: null,
    responseId: null,
    reportedModel: null,
    usage: null,
    text: '',
    refusal: null,
    functionCalls: [],
    unexpectedItems: [],
    incompleteReason: null,
    providerError: null,
    servedBy: null,
    otherPayer: false,
  };
  if (!envelope.readable) return { readable: false, classified: null };
  const readError = (value: Record<string, unknown> | null) => {
    const error = record(value?.error);
    if (error)
      result.providerError ??= {
        code: error.code == null ? null : String(error.code),
        message: bounded(str(error.message) ?? 'Unknown provider error.'),
      };
  };
  if (!envelope.events) {
    readError(record(envelope.body));
    if (!result.providerError) return { readable: false, classified: null };
    result.status = 'failed';
    return { readable: true, classified: result };
  }
  const calls = new Map<number, { callId: string; name: string; arguments: string }>();
  let finish: string | null = null;
  let sawChoice = false;
  for (const event of envelope.events) {
    const chunk = record(event);
    if (!chunk) {
      result.unexpectedItems.push('chunk:not-an-object');
      continue;
    }
    readError(chunk);
    result.responseId ??= str(chunk.id);
    result.reportedModel ??= str(chunk.model);
    result.servedBy ??= str(chunk.provider);
    if (chunk.usage != null) {
      const { usage, byok } = chatUsage(chunk.usage);
      result.usage = usage;
      if (byok) result.otherPayer = true;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const raw of choices) {
      const choice = record(raw);
      if (!choice) continue;
      if (choice.index != null && choice.index !== 0) {
        result.unexpectedItems.push('choice:extra');
        continue;
      }
      sawChoice = true;
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
      const delta = record(choice.delta);
      if (!delta) continue;
      if (typeof delta.content === 'string') result.text += delta.content;
      if (typeof delta.refusal === 'string' && delta.refusal) result.refusal ??= bounded(delta.refusal);
      if (Array.isArray(delta.images) && delta.images.length) result.unexpectedItems.push('images');
      if (Array.isArray(delta.annotations) && delta.annotations.length) result.unexpectedItems.push('annotations');
      if (Array.isArray(delta.tool_calls))
        for (const rawCall of delta.tool_calls) {
          const call = record(rawCall);
          if (!call) continue;
          if (call.type != null && call.type !== 'function') {
            result.unexpectedItems.push(`tool_call:${String(call.type)}`);
            continue;
          }
          const index = typeof call.index === 'number' ? call.index : 0;
          const fn = record(call.function);
          const current = calls.get(index) ?? { callId: '', name: '', arguments: '' };
          if (typeof call.id === 'string' && call.id) current.callId ||= call.id;
          if (typeof fn?.name === 'string' && fn.name) current.name ||= fn.name;
          if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
          calls.set(index, current);
        }
    }
  }
  result.functionCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (result.providerError) result.status = 'failed';
  else if (!sawChoice) result.status = null;
  else if (finish === 'stop' || finish === 'tool_calls') result.status = 'completed';
  else if (finish === 'length') {
    result.status = 'incomplete';
    result.incompleteReason = 'max_output_tokens';
  } else if (finish === 'content_filter') {
    result.status = 'incomplete';
    result.incompleteReason = 'content_filter';
  } else if (finish === 'error') result.providerError = { code: 'finish_error', message: 'The upstream endpoint reported an error.' };
  else if (finish) {
    result.status = 'incomplete';
    result.incompleteReason = finish;
  }
  return { readable: true, classified: result };
}

/** The usage a failed call can still be settled from. */
function chatEnvelopeUsage(envelope: StreamEnvelope): ProviderUsage | null {
  if (!envelope.readable || !envelope.events) return null;
  let usage: ProviderUsage | null = null;
  for (const event of envelope.events) {
    const chunk = record(event);
    if (chunk?.usage != null) usage = chatUsage(chunk.usage).usage;
  }
  return usage;
}

/** An upstream name as reported ("Amazon Bedrock") and as configured ("amazon-bedrock") compare equal. */
export const upstreamSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');

// --- the call ---------------------------------------------------------------------

/** Only the saved OpenRouter key reaches OpenRouter, as a bearer token; no provider keys ride along. */
function attachOpenRouterKey(headers: Headers, secret: string) {
  headers.delete('authorization');
  headers.delete('x-provider-api-keys');
  headers.set('authorization', `Bearer ${secret}`);
}

const refuseBody = () =>
  new ModelApiError(
    'openrouter_request_refused',
    'The request did not carry this connection’s model, endpoints and data policy exactly. Nothing was sent.',
    false,
  );

/** The serialized request carries exactly the admitted model and preferences, and no way to widen them. */
function inspectOpenRouterBody(entry: OpenRouterModel) {
  const expected = JSON.stringify(openRouterPreferences(entry));
  return (text: string) => {
    let body: Record<string, unknown> | null;
    try {
      body = record(JSON.parse(text));
    } catch {
      body = null;
    }
    if (!body) throw refuseBody();
    const provider = record(body.provider);
    const keys = provider ? Object.keys(provider).sort() : [];
    const canonical = provider
      ? JSON.stringify({
          only: provider.only,
          allow_fallbacks: provider.allow_fallbacks,
          require_parameters: provider.require_parameters,
          data_collection: provider.data_collection,
        })
      : null;
    if (
      body.model !== entry.id ||
      'models' in body ||
      'route' in body ||
      'plugins' in body ||
      'web_search_options' in body ||
      body.stream !== true ||
      record(body.usage)?.include !== true ||
      canonical !== expected ||
      keys.join(',') !== 'allow_fallbacks,data_collection,only,require_parameters'
    )
      throw refuseBody();
  };
}

export function openRouterBinding(connection: OpenRouterConnection, entry: OpenRouterModel): RouteBinding {
  const allowed = new Set(entry.upstreams.map(upstreamSlug));
  return {
    route: OPENROUTER_ROUTE,
    prefix: 'openrouter',
    label: 'OpenRouter',
    connectionId: connection.id,
    modelId: entry.id,
    expiresAt: connection.credential.expiresAt,
    model: (fetch) =>
      createOpenRouter({
        baseURL: OPENROUTER_BASE_URL,
        // A placeholder: the guarded transport attaches the real key, and an explicit value
        // stops the SDK reading OPENROUTER_API_KEY. No api_keys: BYOK changes who pays.
        apiKey: CREDENTIAL_PLACEHOLDER,
        compatibility: 'strict',
        fetch,
      }).chat(entry.id, {
        provider: openRouterPreferences(entry),
        usage: { include: true },
        parallelToolCalls: false,
      }),
    guard: {
      expectedUrl: `${OPENROUTER_BASE_URL}/chat/completions`,
      attach: attachOpenRouterKey,
      inspectBody: inspectOpenRouterBody(entry),
      requestIdHeaders: ['x-request-id', 'x-generation-id'],
    },
    providerOptions: {},
    classify: classifyChat,
    usage: chatEnvelopeUsage,
    // 402 is OpenRouter's "no credits": refused before any inference.
    releasableStatuses: new Set([400, 401, 402, 403, 404, 413, 422, 429]),
    served: (classified) => {
      if (classified.otherPayer)
        return {
          code: 'openrouter_payer_changed',
          message:
            'OpenRouter billed this call to a provider key instead of this connection’s credits. The answer was not used.',
        };
      const reported = classified.reportedModel;
      if (!reported || (reported !== entry.id && !reported.startsWith(`${entry.id}-`)))
        return {
          code: 'openrouter_model_changed',
          message: `OpenRouter answered with ${reported ?? 'an unreported model'}, not ${entry.id}. The answer was not used.`,
        };
      const served = classified.servedBy;
      if (!served || !allowed.has(upstreamSlug(served)))
        return {
          code: 'openrouter_endpoint_refused',
          message: `OpenRouter ran this call on ${served ?? 'an unreported endpoint'}, which is not one of this model’s allowed endpoints. The answer was not used.`,
        };
      return null;
    },
  };
}

/** One OpenRouter exchange: reserve, stream once, classify, settle. Never retried, never rerouted. */
export async function respondOpenRouter(
  input: {
    connection: OpenRouterConnection;
    model: string;
    secret: string;
    card: ModelRateCard;
    exposure: SpendExposure;
    attempt: ExposureAttempt;
    instructions: string;
    messages: ModelMessage[];
    tools: readonly ToolDescriptor[];
    limits: RespondLimits;
    signal: AbortSignal;
    transport?: typeof globalThis.fetch;
    now?: () => Date;
  } & StreamSinks,
): Promise<RespondResult> {
  const connection = openRouterConnectionSchema.parse(input.connection);
  const entry = openRouterModelFor(connection, input.model);
  const { connection: _connection, model: _model, ...rest } = input;
  return respondStream({ ...rest, binding: openRouterBinding(connection, entry) });
}
