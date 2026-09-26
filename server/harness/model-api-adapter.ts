/**
 * A model-API route as a `ModelAdapter` for the existing native loop, shared by
 * every route (AWS Bedrock, Azure OpenAI, OpenRouter). `NativeAgent` owns the
 * loop, `RunService` owns every step and the registry owns every tool; this
 * adapter performs exactly one provider exchange per `complete` and nothing
 * else.
 *
 * No route keeps provider-side state between calls, so the continuation is
 * private and local: the provider-format messages (reasoning items, the
 * model's function call and its provider call id) are saved in a
 * content-addressed transcript bound to this run, this profile and the exact
 * portable prefix. The run record carries only the reference. A tool result is
 * returned to the provider under the call id the provider issued. There is no
 * `previous_response_id`: a response id is evidence, never a resumable
 * conversation.
 */
import type { ModelMessage } from 'ai';
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import type { Json, ModelRequest, ModelResult, PortableMessage, ToolDescriptor } from '../../shared/harness.js';
import { ModelApiError, type RespondResult, type StreamSinks } from '../engines/model-api-core.js';
import type { ExposureAttempt } from '../spend-exposure.js';
import type { ModelTranscripts } from './model-transcripts.js';
import type { ModelAdapter } from './native-agent.js';
import { copy, digest } from './policy.js';

const unsupported = (note: string) => ({ support: 'unsupported' as const, note });
const host = (note: string) => ({ support: 'host' as const, note });

/** The route contract every model-API route shares; only its identity and wording differ. */
export function modelApiContract(route: {
  routeId: string;
  sdk: string;
  protocol: string;
  label: string;
}): AdapterRouteContract {
  return {
    contractVersion: 1,
    routeId: route.routeId,
    mode: 'harness-agent',
    engine: { id: route.routeId, version: route.sdk, protocolVersion: route.protocol },
    commands: {
      start: host('RunService admits and records each model call and each registered tool step.'),
      'follow-up': host(
        'Each message is a new bounded turn. Context comes from the durable run record, never from provider-side state.',
      ),
      steer: unsupported('A running call cannot be redirected; stop it and send a new message.'),
      interrupt: host(
        `Stop aborts the HTTP read. It does not prove ${route.label} stopped processing, so the spend hold stays uncertain.`,
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
    streaming: { transientPreview: 'text-delta', durableEvents: 'run-record' },
    models: { source: 'runtime-reported' },
    authentication: 'host-credential',
    testedWith: route.sdk,
  };
}

export interface ModelApiAdapterSpec {
  route: string;
  /** Error-code prefix: `aws`, `azure`, `openrouter`. */
  prefix: string;
  label: string;
  sdk: string;
  protocol: string;
  contract: AdapterRouteContract;
  connectionId: string;
  revision: number;
  /** The logical model requested, recorded beside what the provider reports. */
  requestedModel: string;
  /** Everything that decides what a call means. Its digest binds saved context to this profile. */
  profile: Record<string, unknown>;
  transcripts: ModelTranscripts;
  notes: string[];
  /** One provider exchange. */
  respond(
    input: {
      messages: ModelMessage[];
      tools: readonly ToolDescriptor[];
      attempt: ExposureAttempt;
      signal: AbortSignal;
    } & StreamSinks,
  ): Promise<RespondResult>;
  /** The raw preview sinks this turn's calls feed. */
  sinks?: StreamSinks;
  /**
   * The step boundary: runs before each model step, outside it, and refuses the
   * step when it would pass the job's cap (`admitJobStep`). Absent when the
   * route's ledger is not scoped to a job.
   */
  admitStep?(input: {
    attempt: ExposureAttempt;
    tools: readonly ToolDescriptor[];
    messages: () => Promise<ModelMessage[]>;
  }): Promise<void>;
}

/**
 * The spend hold's step id for one model request, fixed before anything is sent. The observation
 * projector joins a model step to its hold with the same derivation (server/observability/projector.ts).
 */
export function exposureStepId(request: Pick<ModelRequest, 'messages'>): string {
  return `model@${digest(request.messages).slice(0, 24)}`;
}

type Prepared = ModelRequest & {
  modelApiProfile?: { route: string; connectionId: string; revision: number; modelId: string; profileHash: string };
};

/** A spend hold's identity, fixed before anything is sent. */
function exposureAttempt(runId: string, stepId: string, request: unknown): ExposureAttempt {
  return { runId, stepId, attempt: 1, requestDigest: digest(request) };
}

export function createModelApiAdapter(spec: ModelApiAdapterSpec): ModelAdapter & { profileHash: string } {
  const { prefix, label } = spec;
  const profileHash = digest(spec.profile);
  /** Plain text turns only; a tool continuation needs its private transcript. */
  const ordinary = (messages: readonly PortableMessage[]): ModelMessage[] =>
    messages.map((message) => {
      if (
        (message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.text !== 'string' ||
        message.tool !== undefined
      )
        throw new ModelApiError(
          `${prefix}_transcript_mismatch`,
          'A tool continuation needs its matching private transcript. Nothing was sent.',
          false,
        );
      return { role: message.role, content: message.text };
    });
  const boundProfile = (request: ModelRequest) => {
    const bound = (request as Prepared).modelApiProfile?.profileHash;
    if (bound !== undefined && bound !== profileHash)
      throw new ModelApiError(
        `${prefix}_profile_changed`,
        `This saved context belongs to a different ${label} connection, model or mode. It was not sent.`,
        false,
      );
  };
  /** The provider-format messages one step sends: its private continuation plus the new portable tail. */
  const providerMessages = async (request: ModelRequest): Promise<ModelMessage[]> => {
    let messages: ModelMessage[];
    if (request.transcript) {
      const saved = await spec.transcripts.read(request.transcript);
      if (
        saved.runId !== request.runId ||
        saved.capabilityId !== request.capabilityId ||
        saved.profileHash !== profileHash ||
        digest(request.messages.slice(0, saved.portablePrefix.length)) !== digest(saved.portablePrefix)
      )
        throw new ModelApiError(
          `${prefix}_transcript_mismatch`,
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
            `${prefix}_transcript_mismatch`,
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
    return messages;
  };
  /** A spend hold's identity for one step, fixed before anything is sent. */
  const attemptFor = (request: ModelRequest): ExposureAttempt =>
    exposureAttempt(request.runId, exposureStepId(request), {
      runId: request.runId,
      capabilityId: request.capabilityId,
      messages: request.messages,
      tools: request.tools,
      transcript: request.transcript,
      profileHash,
    });
  return {
    id: spec.route,
    version: spec.sdk,
    contract: spec.contract,
    destination: 'external',
    profileHash,
    capabilities: () => ({
      engineId: spec.route,
      engineVersion: spec.sdk,
      protocolVersion: spec.protocol,
      modelCalls: 'enforced',
      toolCalls: 'enforced',
      filesystemWrites: 'unsupported',
      networkEgress: 'enforced',
      approvals: 'unsupported',
      resumability: 'observed',
      cancellability: 'observed',
      checkpointGranularity: 'step',
      notes: spec.notes,
    }),
    async prepare(request, signal) {
      signal.throwIfAborted();
      boundProfile(request);
      const prepared: Prepared = {
        ...copy(request),
        modelApiProfile: {
          route: spec.route,
          connectionId: spec.connectionId,
          revision: spec.revision,
          modelId: spec.requestedModel,
          profileHash,
        },
      };
      return prepared;
    },
    async validatePrepared(request) {
      boundProfile(request);
      // The job's cap is checked here, between steps, so a step it refuses is never started.
      await spec.admitStep?.({
        attempt: attemptFor(request),
        tools: request.tools,
        messages: () => providerMessages(request),
      });
    },
    async complete(request, signal, stream): Promise<ModelResult> {
      signal.throwIfAborted();
      boundProfile(request);
      const messages = await providerMessages(request);
      const routeDelta = spec.sinks?.onDelta;
      const onDelta =
        stream && routeDelta
          ? (text: string) => {
              routeDelta(text);
              stream.onDelta(text);
            }
          : (routeDelta ?? (stream ? (text: string) => stream.onDelta(text) : undefined));
      const attempt = attemptFor(request);

      const result = await spec.respond({
        messages,
        tools: request.tools,
        attempt,
        signal,
        onDelta,
        onToolActivity: spec.sinks?.onToolActivity,
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
      const transcript = await spec.transcripts.save({
        v: 1,
        providerId: spec.route,
        runId: request.runId,
        capabilityId: request.capabilityId,
        profileHash,
        requestedModel: spec.requestedModel,
        reportedModel: result.reportedModel,
        responseId: result.responseId,
        portablePrefix: [...copy(request.messages), portable],
        messages: [...messages, ...result.responseMessages],
        pendingTool,
      });
      return {
        response,
        transcript,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          // The parts of the input the provider read from or wrote to its prompt cache (H18).
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
        },
      };
    },
  };
}
