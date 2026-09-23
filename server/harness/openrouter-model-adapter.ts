/**
 * The OpenRouter route as a `ModelAdapter` for the existing native loop, on the
 * shared model-API adapter. One streamed chat-completions call per model step,
 * for an allow-listed model on its allowed endpoints only.
 */
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import { CONVERSATION_LIMITS, type RespondLimits, type StreamSinks } from '../engines/model-api-core.js';
import {
  OPENROUTER_PROTOCOL,
  OPENROUTER_ROUTE,
  OPENROUTER_SDK,
  openRouterConnectionSchema,
  openRouterModelFor,
  openRouterPreferences,
  respondOpenRouter,
  type OpenRouterConnection,
} from '../engines/openrouter.js';
import type { ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { createModelApiAdapter, modelApiContract } from './model-api-adapter.js';
import type { ModelTranscripts } from './model-transcripts.js';
import type { ModelAdapter } from './native-agent.js';
import { digest } from './policy.js';

export const OPENROUTER_MODEL_CONTRACT: AdapterRouteContract = modelApiContract({
  routeId: OPENROUTER_ROUTE,
  sdk: OPENROUTER_SDK,
  protocol: OPENROUTER_PROTOCOL,
  label: 'OpenRouter',
});

export interface OpenRouterModelAdapterOptions extends StreamSinks {
  connection: OpenRouterConnection;
  model: string;
  secret: string;
  card: ModelRateCard;
  exposure: SpendExposure;
  transcripts: ModelTranscripts;
  instructions: string;
  limits?: RespondLimits;
  transport?: typeof globalThis.fetch;
  now?: () => Date;
}

export function createOpenRouterModelAdapter(
  options: OpenRouterModelAdapterOptions,
): ModelAdapter & { profileHash: string } {
  const connection = Object.freeze(openRouterConnectionSchema.parse(options.connection));
  const entry = openRouterModelFor(connection, options.model);
  const limits = options.limits ?? CONVERSATION_LIMITS;
  return createModelApiAdapter({
    route: OPENROUTER_ROUTE,
    prefix: 'openrouter',
    label: 'OpenRouter',
    sdk: OPENROUTER_SDK,
    protocol: OPENROUTER_PROTOCOL,
    contract: OPENROUTER_MODEL_CONTRACT,
    connectionId: connection.id,
    revision: connection.revision,
    requestedModel: entry.id,
    profile: {
      route: OPENROUTER_ROUTE,
      sdk: OPENROUTER_SDK,
      connectionId: connection.id,
      revision: connection.revision,
      baseUrl: connection.baseUrl,
      model: entry.id,
      preferences: openRouterPreferences(entry),
      instructions: digest(options.instructions),
      limits,
      rateCard: options.card.version,
    },
    transcripts: options.transcripts,
    notes: [
      'One streamed chat-completions call per model step for an allow-listed model, on its listed endpoints only, fallbacks off, data collection denied, parameters required; SDK retries off, one tool call at most; tools are descriptors run only by the harness.',
      'The key is attached only to the chat-completions endpoint; no provider keys are sent, and a BYOK charge refuses the answer.',
      'The reported model and serving endpoint are checked against the request before the answer is used.',
      'Stopping a call closes the HTTP read and leaves its spend hold uncertain.',
    ],
    sinks: { onDelta: options.onDelta, onToolActivity: options.onToolActivity },
    respond: (call) =>
      respondOpenRouter({
        connection,
        model: entry.id,
        secret: options.secret,
        card: options.card,
        exposure: options.exposure,
        instructions: options.instructions,
        limits,
        transport: options.transport,
        now: options.now,
        ...call,
      }),
  });
}
