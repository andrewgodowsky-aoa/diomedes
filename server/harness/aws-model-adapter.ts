/**
 * The AWS Bedrock Responses route as a `ModelAdapter` for the existing native
 * loop. `NativeAgent` owns the loop, `RunService` owns every step and the
 * registry owns every tool; this adapter performs exactly one provider exchange
 * per `complete` and nothing else.
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
import type { ModelMessage } from 'ai';
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import type { Json, ModelRequest, ModelResult, PortableMessage } from '../../shared/harness.js';
import {
  AWS_BEDROCK_PROTOCOL,
  AWS_BEDROCK_ROUTE,
  AWS_BEDROCK_SDK,
  CONVERSATION_LIMITS,
  ModelApiError,
  awsConnectionSchema,
  exposureAttempt,
  respondOnce,
  type AwsConnection,
  type RespondLimits,
} from '../engines/aws-bedrock.js';
import type { ModelRateCard, SpendExposure } from '../spend-exposure.js';
import type { ModelTranscripts } from './model-transcripts.js';
import type { ModelAdapter } from './native-agent.js';
import { copy, digest } from './policy.js';

const unsupported = (note: string) => ({ support: 'unsupported' as const, note });
const host = (note: string) => ({ support: 'host' as const, note });

export const AWS_MODEL_CONTRACT: AdapterRouteContract = {
  contractVersion: 1,
  routeId: AWS_BEDROCK_ROUTE,
  mode: 'harness-agent',
  engine: { id: AWS_BEDROCK_ROUTE, version: AWS_BEDROCK_SDK, protocolVersion: AWS_BEDROCK_PROTOCOL },
  commands: {
    start: host('RunService admits and records each model call and each registered tool step.'),
    'follow-up': host(
      'Each message is a new bounded turn. Context comes from the durable run record, never from provider-side state.',
    ),
    steer: unsupported('A running call cannot be redirected; stop it and send a new message.'),
    interrupt: host(
      'Stop aborts the HTTP read. It does not prove AWS stopped processing, so the spend hold stays uncertain.',
    ),
    resume: host(
      'Completed calls replay from RunService and the private transcript. No provider conversation is resumed.',
    ),
    retry: host('The SDK never retries. An uncertain call is reconciled, never sent again.'),
    fork: unsupported('Forking a model-API conversation is not supported.'),
    status: host('The durable run record and the spend ledger say what happened.'),
    reconcile: unsupported(
      'An uncertain call stays held in the spend ledger until the owner records its actual cost or writes it off.',
    ),
    close: host('There is no provider process or session to close.'),
  },
  streaming: { transientPreview: 'none', durableEvents: 'run-record' },
  models: { source: 'runtime-reported' },
  authentication: 'host-credential',
  testedWith: AWS_BEDROCK_SDK,
};

export interface AwsModelAdapterOptions {
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

type Prepared = ModelRequest & {
  modelApiProfile?: { route: string; connectionId: string; revision: number; modelId: string; profileHash: string };
};

/** Plain text turns only; a tool continuation needs its private transcript. */
function ordinary(messages: readonly PortableMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string' ||
      message.tool !== undefined
    )
      throw new ModelApiError(
        'aws_transcript_mismatch',
        'A tool continuation needs its matching private transcript. Nothing was sent.',
        false,
      );
    return { role: message.role, content: message.text };
  });
}

export function createAwsModelAdapter(options: AwsModelAdapterOptions): ModelAdapter & { profileHash: string } {
  const connection = Object.freeze(awsConnectionSchema.parse(options.connection));
  const limits = options.limits ?? CONVERSATION_LIMITS;
  const profileHash = digest({
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
  });
  const boundProfile = (request: ModelRequest) => {
    const bound = (request as Prepared).modelApiProfile?.profileHash;
    if (bound !== undefined && bound !== profileHash)
      throw new ModelApiError(
        'aws_profile_changed',
        'This saved context belongs to a different AWS connection, model or mode. It was not sent.',
        false,
      );
  };
  return {
    id: AWS_BEDROCK_ROUTE,
    version: AWS_BEDROCK_SDK,
    contract: AWS_MODEL_CONTRACT,
    destination: 'external',
    profileHash,
    capabilities: () => ({
      engineId: AWS_BEDROCK_ROUTE,
      engineVersion: AWS_BEDROCK_SDK,
      protocolVersion: AWS_BEDROCK_PROTOCOL,
      modelCalls: 'enforced',
      toolCalls: 'enforced',
      filesystemWrites: 'unsupported',
      networkEgress: 'enforced',
      approvals: 'unsupported',
      resumability: 'observed',
      cancellability: 'observed',
      checkpointGranularity: 'step',
      notes: [
        'One Responses call per model step, store:false, SDK retries off, one tool call at most; tools are descriptors run only by the harness.',
        'The credential is attached only to the approved runtime origin and path; redirects are refused.',
        'The reported model is the provider envelope’s model field, recorded beside the requested model.',
        'Stopping a call closes the HTTP read and leaves its spend hold uncertain.',
      ],
    }),
    async prepare(request, signal) {
      signal.throwIfAborted();
      boundProfile(request);
      const prepared: Prepared = {
        ...copy(request),
        modelApiProfile: {
          route: AWS_BEDROCK_ROUTE,
          connectionId: connection.id,
          revision: connection.revision,
          modelId: connection.modelId,
          profileHash,
        },
      };
      return prepared;
    },
    async validatePrepared(request) {
      boundProfile(request);
    },
    async complete(request, signal): Promise<ModelResult> {
      signal.throwIfAborted();
      boundProfile(request);
      let messages: ModelMessage[];
      if (request.transcript) {
        const saved = await options.transcripts.read(request.transcript);
        if (
          saved.runId !== request.runId ||
          saved.capabilityId !== request.capabilityId ||
          saved.profileHash !== profileHash ||
          digest(request.messages.slice(0, saved.portablePrefix.length)) !== digest(saved.portablePrefix)
        )
          throw new ModelApiError(
            'aws_transcript_mismatch',
            'The private continuation does not match this run, context, model or account. Nothing was sent.',
            false,
          );
        messages = copy(saved.messages) as ModelMessage[];
        const tail = request.messages.slice(saved.portablePrefix.length);
        if (saved.pendingTool) {
          const observation = tail.shift();
          if (
            !observation ||
            observation.role !== 'tool' ||
            observation.name !== saved.pendingTool.name ||
            observation.output === undefined
          )
            throw new ModelApiError(
              'aws_transcript_mismatch',
              'The pending tool call has no matching recorded result. Nothing was sent.',
              false,
            );
          // The provider's own call id, recorded when it asked, answers it now.
          messages.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: saved.pendingTool.callId,
                toolName: saved.pendingTool.name,
                output: { type: 'json', value: observation.output as never },
              },
            ],
          });
        }
        messages.push(...ordinary(tail));
      } else messages = ordinary(request.messages);

      const attempt = exposureAttempt(
        request.runId,
        `model@${digest(request.messages).slice(0, 24)}`,
        { runId: request.runId, capabilityId: request.capabilityId, messages: request.messages, tools: request.tools, transcript: request.transcript, profileHash },
      );
      const result = await respondOnce({
        connection,
        secret: options.secret,
        card: options.card,
        exposure: options.exposure,
        attempt,
        instructions: options.instructions,
        messages,
        tools: request.tools,
        effort: options.effort,
        limits,
        signal,
        transport: options.transport,
        now: options.now,
      });
      let response: ModelResult['response'];
      let portable: PortableMessage;
      let pendingTool: { callId: string; name: string; input: Json } | null = null;
      if (result.outcome.kind === 'tool') {
        response = { type: 'tool', name: result.outcome.name, input: result.outcome.input };
        portable = { role: 'assistant', tool: result.outcome.name, input: result.outcome.input };
        pendingTool = { callId: result.outcome.callId, name: result.outcome.name, input: result.outcome.input };
      } else {
        response = { type: 'final', text: result.outcome.text };
        portable = { role: 'assistant', text: result.outcome.text };
      }
      const transcript = await options.transcripts.save({
        v: 1,
        providerId: AWS_BEDROCK_ROUTE,
        runId: request.runId,
        capabilityId: request.capabilityId,
        profileHash,
        requestedModel: connection.modelId,
        reportedModel: result.reportedModel,
        responseId: result.responseId,
        portablePrefix: [...copy(request.messages), portable],
        messages: [...messages, ...result.responseMessages],
        pendingTool,
      });
      return {
        response,
        transcript,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      };
    },
  };
}
