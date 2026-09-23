/**
 * The AWS Bedrock Responses route as a `ModelAdapter` for the existing native
 * loop, built on the shared model-API adapter (`model-api-adapter.ts`).
 * `NativeAgent` owns the loop, `RunService` owns every step and the registry
 * owns every tool; this adapter performs exactly one provider exchange per
 * `complete` and nothing else.
 *
 * `store: false` means AWS keeps nothing between calls, so the continuation is
 * private and local: the provider-format messages (encrypted reasoning items,
 * the model's function call and its provider call id) are saved in a
 * content-addressed transcript bound to this run, this profile and the exact
 * portable prefix. The run record carries only the reference. A tool result is
 * returned to the provider under the call id the provider issued, which is how a
 * canonical `tool:<i>` step maps to a provider call without a public call-id
 * field. There is no `previous_response_id`: a response id is evidence, never a
 * resumable conversation.
 */
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import {
  AWS_BEDROCK_PROTOCOL,
  AWS_BEDROCK_ROUTE,
  AWS_BEDROCK_SDK,
  CONVERSATION_LIMITS,
  awsConnectionSchema,
  respondOnce,
  type AwsConnection,
  type RespondLimits,
} from '../engines/aws-bedrock.js';
import { admitJobStep, type StreamSinks } from '../engines/model-api-core.js';
import type { ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { createModelApiAdapter, modelApiContract } from './model-api-adapter.js';
import type { ModelTranscripts } from './model-transcripts.js';
import type { ModelAdapter } from './native-agent.js';
import { digest } from './policy.js';

export const AWS_MODEL_CONTRACT: AdapterRouteContract = modelApiContract({
  routeId: AWS_BEDROCK_ROUTE,
  sdk: AWS_BEDROCK_SDK,
  protocol: AWS_BEDROCK_PROTOCOL,
  label: 'AWS',
});

export interface AwsModelAdapterOptions extends StreamSinks {
  connection: AwsConnection;
  secret: string;
  card: ModelRateCard;
  exposure: SpendExposure;
  transcripts: ModelTranscripts;
  /** The mode's instructions for this turn. Part of the bound profile, so a changed mode cannot replay. */
  instructions: string;
  effort: 'low' | 'medium' | 'high';
  limits?: RespondLimits;
  transport?: typeof globalThis.fetch;
  now?: () => Date;
}

export function createAwsModelAdapter(options: AwsModelAdapterOptions): ModelAdapter & { profileHash: string } {
  const connection = Object.freeze(awsConnectionSchema.parse(options.connection));
  const limits = options.limits ?? CONVERSATION_LIMITS;
  return createModelApiAdapter({
    route: AWS_BEDROCK_ROUTE,
    prefix: 'aws',
    label: 'AWS',
    sdk: AWS_BEDROCK_SDK,
    protocol: AWS_BEDROCK_PROTOCOL,
    contract: AWS_MODEL_CONTRACT,
    connectionId: connection.id,
    revision: connection.revision,
    requestedModel: connection.modelId,
    profile: {
      route: AWS_BEDROCK_ROUTE,
      sdk: AWS_BEDROCK_SDK,
      connectionId: connection.id,
      revision: connection.revision,
      baseUrl: connection.baseUrl,
      modelId: connection.modelId,
      instructions: digest(options.instructions),
      effort: options.effort,
      limits,
      rateCard: options.card.version,
    },
    transcripts: options.transcripts,
    notes: [
      'One streamed Responses call per model step, store:false, SDK retries off, one tool call at most; tools are descriptors run only by the harness.',
      'The credential is attached only to the approved runtime origin and path; redirects are refused.',
      'The reported model is the provider envelope’s model field, recorded beside the requested model.',
      'Stopping a call closes the HTTP read and leaves its spend hold uncertain.',
    ],
    sinks: { onDelta: options.onDelta, onToolActivity: options.onToolActivity },
    admitStep: (call) =>
      admitJobStep({
        prefix: 'aws',
        connectionId: connection.id,
        exposure: options.exposure,
        card: options.card,
        instructions: options.instructions,
        limits,
        ...call,
      }),
    respond: (call) =>
      respondOnce({
        connection,
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
