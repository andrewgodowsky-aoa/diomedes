import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText, jsonSchema, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import type {
  Json,
  ModelRequest,
  ModelResult,
  PortableMessage,
  ProviderTranscriptRef,
} from '../../shared/harness.js';
import type { ModelAdapter } from './native-agent.js';
import { copy, digest, HarnessError } from './policy.js';

export const BEDROCK_SDK_VERSION = 'ai@7.0.107/amazon-bedrock@5.0.88';
export const BEDROCK_LUNA_MODEL = 'us.openai.gpt-5.6-luna';

export const bedrockRegionSchema = z
  .string()
  .regex(/^(us|eu|ap|ca|sa|me|af|il|mx)-(?:[a-z]+-){1,2}[0-9]$/);
const profileSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  accountRoute: z.string().min(1).max(200),
  region: bedrockRegionSchema,
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,199}$/),
  maxOutputTokens: z.number().int().min(1).max(32_768).default(4096),
  maxInputBytes: z.number().int().min(1).max(1_048_576).default(160_000),
  maxOutputBytes: z.number().int().min(1).max(262_144).default(65_536),
  instructions: z.string().max(32_000).default(''),
});
export type BedrockModelProfile = z.input<typeof profileSchema>;
export type BedrockCredentials =
  | { kind: 'bearer'; apiKey: string }
  | { kind: 'sigv4'; accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** Private provider continuation. This must never be serialized into the UI's portable chat. */
export interface SdkTranscript {
  v: 1;
  providerId: 'amazon-bedrock';
  runId: string;
  capabilityId: string;
  profileHash: string;
  modelId: string;
  portablePrefix: PortableMessage[];
  messages: ModelMessage[];
  pendingTool: { id: string; name: string; input: Json } | null;
}
export interface SdkTranscripts {
  save(value: SdkTranscript): Promise<ProviderTranscriptRef>;
  read(ref: ProviderTranscriptRef): Promise<SdkTranscript>;
}
type Usage = NonNullable<ModelResult['usage']>;
export class SdkOperationError extends HarnessError {
  constructor(
    code: string,
    message: string,
    readonly dispatched: boolean,
    readonly usage: Usage | null = null,
  ) {
    super(code, message);
    this.name = 'SdkOperationError';
  }
}

const unsupported = {
  support: 'unsupported' as const,
  note: 'This model operation has no independent session lifecycle.',
};
export const BEDROCK_SDK_CONTRACT: AdapterRouteContract = {
  contractVersion: 1,
  routeId: 'amazon-bedrock',
  mode: 'harness-agent',
  engine: {
    id: 'amazon-bedrock',
    version: BEDROCK_SDK_VERSION,
    protocolVersion: 'bedrock-converse',
  },
  commands: {
    start: { support: 'host', note: 'RunService authorizes and records each SDK model operation.' },
    'follow-up': {
      support: 'host',
      note: 'The host supplies the next authorized portable input and a bound private continuation.',
    },
    steer: unsupported,
    interrupt: {
      support: 'host',
      note: 'AbortSignal closes the HTTP read. It does not prove AWS stopped billing.',
    },
    resume: {
      support: 'host',
      note: 'Known results replay from RunService; private continuations are bound to the original profile.',
    },
    retry: {
      support: 'host',
      note: 'SDK retries are disabled. Unknown dispatches must be reconciled by RunService.',
    },
    fork: unsupported,
    status: { support: 'host', note: 'The durable run record owns status.' },
    reconcile: unsupported,
    close: {
      support: 'host',
      note: 'The host aborts its operation; there is no SDK-owned process or session.',
    },
  },
  streaming: { transientPreview: 'none', durableEvents: 'run-record' },
  models: { source: 'fixed' },
  authentication: 'host-credential',
  testedWith: BEDROCK_SDK_VERSION,
};

export function validateBedrockCredentials(value: BedrockCredentials): BedrockCredentials {
  const key = z
    .string()
    .min(1)
    .max(16_384)
    .refine((text) => text === text.trim());
  const parsed = z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('bearer'), apiKey: key }),
      z.strictObject({
        kind: z.literal('sigv4'),
        accessKeyId: key,
        secretAccessKey: key,
        sessionToken: key.optional(),
      }),
    ])
    .safeParse(value);
  if (!parsed.success)
    throw new SdkOperationError(
      'sdk_credentials_required',
      'Explicit AWS credentials are required for this account route.',
      false,
    );
  return parsed.data;
}

function measuredUsage(value: { inputTokens?: number; outputTokens?: number }): Usage | null {
  const usage: Usage = {};
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key]! < 0)
      throw new SdkOperationError('sdk_invalid_usage', 'AWS returned invalid token usage.', true);
    usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}

function ordinaryMessages(messages: PortableMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string' ||
      message.tool
    )
      throw new SdkOperationError(
        'sdk_invalid_context',
        'A tool continuation needs its matching private provider transcript.',
        false,
      );
    return { role: message.role, content: message.text };
  });
}

/** One SDK operation, with descriptor-only tools. The host remains the only tool executor. */
export function createBedrockModelAdapter(options: {
  profile: BedrockModelProfile;
  credentials: BedrockCredentials;
  transcripts: SdkTranscripts;
  fetch?: typeof globalThis.fetch;
}): ModelAdapter {
  const profile = Object.freeze(profileSchema.parse(options.profile));
  const credentials = validateBedrockCredentials(options.credentials);
  const profileHash = digest({ ...profile, provider: 'amazon-bedrock', sdk: BEDROCK_SDK_VERSION });
  const boundProfile = (request: ModelRequest) => {
    const bound = (request as ModelRequest & { sdkProfileHash?: string }).sdkProfileHash;
    if (bound !== undefined && bound !== profileHash)
      throw new SdkOperationError(
        'sdk_profile_changed',
        'This prepared request belongs to a different model or account profile.',
        false,
      );
  };
  return {
    id: 'amazon-bedrock',
    version: BEDROCK_SDK_VERSION,
    contract: BEDROCK_SDK_CONTRACT,
    destination: 'external',
    capabilities: () => ({
      engineId: 'amazon-bedrock',
      engineVersion: BEDROCK_SDK_VERSION,
      protocolVersion: 'bedrock-converse',
      modelCalls: 'enforced',
      toolCalls: 'enforced',
      filesystemWrites: 'unsupported',
      networkEgress: 'observed',
      approvals: 'unsupported',
      resumability: 'observed',
      cancellability: 'observed',
      checkpointGranularity: 'step',
      notes: [
        'One SDK call per operation with retries disabled; no SDK tool executor is registered.',
        'The exact model and AWS account route are configured. Converse does not independently attest which weights served the response.',
        'Cancellation stops the client request and does not assert that AWS incurred no usage.',
      ],
    }),
    async prepare(request, signal) {
      signal.throwIfAborted();
      boundProfile(request);
      return {
        ...copy(request),
        sdkProfileHash: profileHash,
        sdkProfile: {
          id: profile.id,
          providerId: 'amazon-bedrock',
          accountRoute: profile.accountRoute,
          modelId: profile.modelId,
          region: profile.region,
          maxOutputTokens: profile.maxOutputTokens,
        },
      };
    },
    async validatePrepared(request) {
      boundProfile(request);
    },
    async complete(request, signal): Promise<ModelResult> {
      let dispatched = false;
      let usage: Usage | null = null;
      const refuse = (code: string, message: string): never => {
        throw new SdkOperationError(code, message, dispatched, usage);
      };
      const cancelled = () => {
        if (signal.aborted) refuse('sdk_cancelled', 'The AWS model request was cancelled.');
      };
      try {
        cancelled();
        boundProfile(request);
        if (
          Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(profile.instructions) >
          profile.maxInputBytes
        )
          refuse(
            'sdk_input_too_large',
            "The selected context exceeds this model profile's input limit.",
          );
        let messages: ModelMessage[];
        if (request.transcript) {
          if (
            request.transcript.providerId !== 'amazon-bedrock' ||
            request.transcript.lineageId !== request.runId
          )
            refuse(
              'sdk_transcript_mismatch',
              'This provider continuation belongs to a different run or provider.',
            );
          const saved = await options.transcripts.read(request.transcript);
          if (
            saved.v !== 1 ||
            saved.runId !== request.runId ||
            saved.capabilityId !== request.capabilityId ||
            saved.profileHash !== profileHash ||
            digest(request.messages.slice(0, saved.portablePrefix.length)) !==
              digest(saved.portablePrefix)
          )
            refuse(
              'sdk_transcript_mismatch',
              'The provider continuation does not match this run, context, model or account.',
            );
          const tail = request.messages.slice(saved.portablePrefix.length);
          messages = copy(saved.messages);
          if (saved.pendingTool) {
            const observation = tail.shift();
            if (
              !observation ||
              observation.role !== 'tool' ||
              observation.name !== saved.pendingTool.name ||
              observation.output === undefined
            )
              refuse(
                'sdk_transcript_mismatch',
                'The pending tool has no matching authorized observation.',
              );
            messages.push({
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: saved.pendingTool.id,
                  toolName: saved.pendingTool.name,
                  output: { type: 'json', value: observation!.output! },
                },
              ],
            });
          }
          messages.push(...ordinaryMessages(tail));
        } else messages = ordinaryMessages(request.messages);
        if (
          Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(profile.instructions) >
          profile.maxInputBytes
        )
          refuse(
            'sdk_input_too_large',
            "The private provider context exceeds this model profile's input limit.",
          );

        const tools: ToolSet = {};
        if (request.tools.length > 64)
          refuse('sdk_invalid_tools', 'This model operation offers too many tools.');
        for (const descriptor of request.tools) {
          if (
            !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(descriptor.name) ||
            Object.hasOwn(tools, descriptor.name) ||
            !descriptor.inputSchema ||
            typeof descriptor.inputSchema !== 'object' ||
            Array.isArray(descriptor.inputSchema) ||
            descriptor.inputSchema.type !== 'object'
          )
            refuse(
              'sdk_invalid_tools',
              'This model route requires unique function names and object JSON schemas.',
            );
          Object.defineProperty(tools, descriptor.name, {
            enumerable: true,
            value: {
              description: descriptor.description,
              inputSchema: jsonSchema(descriptor.inputSchema as Parameters<typeof jsonSchema>[0]),
            },
          });
        }
        cancelled();
        const provider = createAmazonBedrock({
          region: profile.region,
          // Empty apiKey deliberately disables the SDK's ambient bearer-token fallback in SigV4 mode.
          ...(credentials.kind === 'bearer'
            ? { apiKey: credentials.apiKey }
            : {
                apiKey: '',
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                sessionToken: credentials.sessionToken,
              }),
          fetch: async (input, init) => {
            cancelled();
            dispatched = true;
            const response = await (options.fetch ?? globalThis.fetch)(input, {
              ...init,
              redirect: 'error',
            });
            const reader = response.body?.getReader();
            if (!reader) return response;
            const chunks: Uint8Array[] = [];
            let size = 0;
            const transportLimit = profile.maxOutputBytes * 4 + 65_536;
            let abortRead!: () => void;
            const interrupted = new Promise<never>((_resolve, reject) => {
              abortRead = () =>
                reject(
                  new SdkOperationError(
                    'sdk_cancelled',
                    'The AWS model request was cancelled.',
                    true,
                  ),
                );
              signal.addEventListener('abort', abortRead, { once: true });
            });
            try {
              while (true) {
                cancelled();
                const part = await Promise.race([reader.read(), interrupted]);
                if (part.done) break;
                size += part.value.byteLength;
                if (size > transportLimit) {
                  await reader.cancel();
                  refuse(
                    'sdk_output_too_large',
                    "The AWS response exceeded this operation's byte limit.",
                  );
                }
                chunks.push(part.value);
              }
            } finally {
              signal.removeEventListener('abort', abortRead);
              try {
                if (signal.aborted) await reader.cancel();
              } finally {
                reader.releaseLock();
              }
            }
            return new Response(Buffer.concat(chunks), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          },
        });
        const result = await generateText({
          model: provider.languageModel(profile.modelId),
          messages,
          ...(profile.instructions ? { system: profile.instructions } : {}),
          tools,
          maxOutputTokens: profile.maxOutputTokens,
          maxRetries: 0,
          stopWhen: stepCountIs(1),
          abortSignal: signal,
        });
        usage = measuredUsage(result.usage);
        cancelled();
        if (result.finishReason === 'content-filter')
          refuse('sdk_refused', 'AWS refused this request.');
        if (result.finishReason === 'length')
          refuse(
            'sdk_incomplete_output',
            'AWS reached the output limit before completing its answer.',
          );
        if (!['stop', 'tool-calls'].includes(result.finishReason))
          refuse('sdk_unknown_finish', 'AWS did not report a supported completion reason.');
        if (result.toolCalls.length > 1)
          refuse(
            'sdk_multiple_tools',
            'This operation returned multiple tool proposals; none were admitted.',
          );
        const proposal = result.toolCalls[0];
        let response: ModelResult['response'];
        let pendingTool: SdkTranscript['pendingTool'] = null;
        let portable: PortableMessage;
        if (proposal) {
          if (
            !Object.hasOwn(tools, proposal.toolName) ||
            ('invalid' in proposal && proposal.invalid)
          )
            refuse('sdk_invalid_tool', 'AWS returned an invalid or unoffered tool proposal.');
          const parsedInput = z.record(z.string(), z.json()).safeParse(proposal.input);
          if (!parsedInput.success)
            refuse('sdk_invalid_tool', 'AWS returned a tool proposal without object input.');
          const input = parsedInput.data! as Json;
          response = { type: 'tool', name: proposal.toolName, input };
          portable = { role: 'assistant', tool: proposal.toolName, input };
          pendingTool = { id: proposal.toolCallId, name: proposal.toolName, input };
        } else {
          if (result.finishReason === 'tool-calls')
            refuse('sdk_invalid_tool', 'AWS reported a tool call without a valid proposal.');
          if (!result.text.trim()) refuse('sdk_empty_output', 'AWS returned no answer.');
          response = { type: 'final', text: result.text };
          portable = { role: 'assistant', text: result.text };
        }
        if (Buffer.byteLength(JSON.stringify(response)) > profile.maxOutputBytes)
          refuse('sdk_output_too_large', "The AWS output exceeds this operation's byte limit.");
        const transcript = await options.transcripts.save({
          v: 1,
          providerId: 'amazon-bedrock',
          runId: request.runId,
          capabilityId: request.capabilityId,
          profileHash,
          modelId: profile.modelId,
          portablePrefix: [...copy(request.messages), portable],
          messages: [...messages, ...copy(result.response.messages)],
          pendingTool,
        });
        cancelled();
        return { response, transcript, usage };
      } catch (error) {
        if (error instanceof SdkOperationError) throw error;
        if (signal.aborted) refuse('sdk_cancelled', 'The AWS model request was cancelled.');
        if (error instanceof HarnessError) throw error;
        const name = error instanceof Error ? error.name : '';
        if (/NoSuchTool|InvalidToolInput|ToolCall/.test(name))
          refuse('sdk_invalid_tool', 'AWS returned an invalid or unoffered tool proposal.');
        if (/APICallError/.test(name))
          refuse(
            'sdk_provider_error',
            'The AWS model request failed. Check model access, credentials and service status.',
          );
        return refuse(
          dispatched ? 'sdk_unknown_outcome' : 'sdk_invalid_request',
          dispatched
            ? 'The AWS request has no verified result. Check its durable run before retrying.'
            : 'The AWS model request could not be prepared.',
        );
      }
    },
  };
}
