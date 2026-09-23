/**
 * The Azure OpenAI route as a `ModelAdapter` for the existing native loop, on
 * the shared model-API adapter. One streamed Responses call per model step to
 * the connection's own resource and the admitted model's deployment.
 */
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import {
  AZURE_OPENAI_PROTOCOL,
  AZURE_OPENAI_ROUTE,
  AZURE_OPENAI_SDK,
  azureConnectionSchema,
  azureDeploymentFor,
  respondAzure,
  type AzureConnection,
} from '../engines/azure-openai.js';
import { admitJobStep, CONVERSATION_LIMITS, type RespondLimits, type StreamSinks } from '../engines/model-api-core.js';
import type { ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { createModelApiAdapter, modelApiContract } from './model-api-adapter.js';
import type { ModelTranscripts } from './model-transcripts.js';
import type { ModelAdapter } from './native-agent.js';
import { digest } from './policy.js';

export const AZURE_MODEL_CONTRACT: AdapterRouteContract = modelApiContract({
  routeId: AZURE_OPENAI_ROUTE,
  sdk: AZURE_OPENAI_SDK,
  protocol: AZURE_OPENAI_PROTOCOL,
  label: 'Azure',
});

export interface AzureModelAdapterOptions extends StreamSinks {
  connection: AzureConnection;
  /** The admitted logical model; the connection maps it to one deployment. */
  model: string;
  secret: string;
  card: ModelRateCard;
  exposure: SpendExposure;
  transcripts: ModelTranscripts;
  instructions: string;
  effort: 'low' | 'medium' | 'high';
  limits?: RespondLimits;
  transport?: typeof globalThis.fetch;
  now?: () => Date;
}

export function createAzureModelAdapter(options: AzureModelAdapterOptions): ModelAdapter & { profileHash: string } {
  const connection = Object.freeze(azureConnectionSchema.parse(options.connection));
  const entry = azureDeploymentFor(connection, options.model);
  const limits = options.limits ?? CONVERSATION_LIMITS;
  return createModelApiAdapter({
    route: AZURE_OPENAI_ROUTE,
    prefix: 'azure',
    label: 'Azure',
    sdk: AZURE_OPENAI_SDK,
    protocol: AZURE_OPENAI_PROTOCOL,
    contract: AZURE_MODEL_CONTRACT,
    connectionId: connection.id,
    revision: connection.revision,
    requestedModel: entry.model,
    profile: {
      route: AZURE_OPENAI_ROUTE,
      sdk: AZURE_OPENAI_SDK,
      connectionId: connection.id,
      revision: connection.revision,
      baseUrl: connection.baseUrl,
      apiVersion: connection.apiVersion,
      model: entry.model,
      deployment: entry.deployment,
      reasoning: entry.reasoning,
      instructions: digest(options.instructions),
      effort: options.effort,
      limits,
      rateCard: options.card.version,
    },
    transcripts: options.transcripts,
    notes: [
      'One streamed Responses call per model step to the resource’s own v1 endpoint, naming the admitted deployment; store:false, SDK retries off, one tool call at most; tools are descriptors run only by the harness.',
      'The resource key is attached only to that endpoint, in the api-key header; redirects are refused.',
      'The reported model is the provider envelope’s model field, recorded beside the requested model and its deployment.',
      'Stopping a call closes the HTTP read and leaves its spend hold uncertain.',
    ],
    sinks: { onDelta: options.onDelta, onToolActivity: options.onToolActivity },
    admitStep: (call) =>
      admitJobStep({
        prefix: 'azure',
        connectionId: connection.id,
        exposure: options.exposure,
        card: options.card,
        instructions: options.instructions,
        limits,
        ...call,
      }),
    respond: (call) =>
      respondAzure({
        connection,
        model: entry.model,
        secret: options.secret,
        card: options.card,
        exposure: options.exposure,
        instructions: options.instructions,
        effort: options.effort,
        limits,
        transport: options.transport,
        now: options.now,
        ...call,
      }),
  });
}
