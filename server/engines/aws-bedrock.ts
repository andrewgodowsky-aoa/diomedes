/**
 * The direct AWS Bedrock Responses route (SDKR-AWS-01, amended by SDKR-CONN-02).
 *
 * One route, pinned end to end: the Bedrock runtime's OpenAI-compatible
 * Responses endpoint in us-east-1, the Geo inference profile
 * `us.openai.gpt-5.6-luna`, the company's own AWS account, `store: false`, one
 * provider exchange per call and no fallback of any kind. There is no Gateway,
 * no bare model string, no ambient `OPENAI_API_KEY` or AWS environment
 * variable, no SDK retry and no SDK tool executor: every tool the model may
 * name is a descriptor, and the Diomedes harness is the only thing that runs it.
 *
 * What this file owns:
 *   - the connection record (non-secret) and its account route string;
 *   - the guarded transport, which is the only code that attaches the
 *     credential, and only to the exact vetted origin and path;
 *   - classification of the raw Responses envelope, so a refusal, a truncated
 *     answer, a batch of tool calls or an unreadable body is never reported as a
 *     finished answer;
 *   - the spend reservation around each call: reserved before the request
 *     leaves, settled from the provider's own usage, uncertain when nobody knows;
 *   - the single-call text adapter Work uses to prepare a file proposal.
 *
 * The call itself (reserve, one streamed exchange, classify, settle) is shared
 * with the other model-API routes in `model-api-core.ts`; this file supplies
 * the AWS binding.
 *
 * The conversation's tool loop is `NativeAgent`'s; its adapter lives in
 * `server/harness/aws-model-adapter.ts` and calls `respondOnce` here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ToolDescriptor } from '../../shared/harness.js';
import { micro } from '../../shared/managed-usage.js';
import { digest, HarnessError } from '../harness/policy.js';
import type { ExposureAttempt, ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { jsonWrite } from '../store.js';
import {
  classifyEnvelope,
  CREDENTIAL_PLACEHOLDER,
  guardedStreamFetch,
  respondStream,
  responsesBody,
  responsesUsage,
  type RespondLimits,
  type RespondResult,
  type RouteBinding,
  type StreamEnvelope,
  type StreamSinks,
} from './model-api-core.js';

export {
  classifyEnvelope,
  CONVERSATION_LIMITS,
  inputTokenBound,
  ModelApiError,
  providerUsage,
  WORK_LIMITS,
  type ClassifiedEnvelope,
  type RespondLimits,
  type RespondOutcome,
  type RespondResult,
} from './model-api-core.js';

export const AWS_BEDROCK_ROUTE = 'aws-bedrock' as const;
/** The exact dependency pair this route was written and tested against. */
export const AWS_BEDROCK_SDK = 'ai@7.0.107+@ai-sdk/openai@4.0.71';
export const AWS_BEDROCK_PROTOCOL = 'openai-responses';
export const AWS_LUNA_MODEL = 'us.openai.gpt-5.6-luna';
/**
 * The runtime endpoint the Luna model card pairs with the Geo profile. The
 * Luna-specific Mantle base (`bedrock-mantle…/openai/v1`, model
 * `openai.gpt-5.6-luna`) is a different route with its own identity; it is not
 * accepted here and is never substituted.
 */
export const AWS_RESPONSES_ENDPOINTS = {
  'us-east-1': 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
} as const;
export type AwsRegion = keyof typeof AWS_RESPONSES_ENDPOINTS;
/**
 * Reviewed model candidates. The runtime has no OpenAI `GET /models`, and an
 * invoke-only key may not be allowed to enumerate the Bedrock catalog, so the
 * route uses this explicit, vetted list rather than calling a key invalid.
 */
export const AWS_VETTED_MODELS: Record<AwsRegion, readonly string[]> = {
  'us-east-1': [AWS_LUNA_MODEL],
};

/**
 * List prices from the AWS model card for the Geo (`us.`) profile, read
 * 2026-09-21: an application estimate of gross cost, never an invoice and
 * never a statement about promotional credit.
 */
export const AWS_LUNA_RATE_CARD: ModelRateCard = {
  version: 'aws-bedrock-luna-2026-09-21.1',
  route: AWS_BEDROCK_ROUTE,
  modelId: AWS_LUNA_MODEL,
  source:
    'AWS Bedrock model card, OpenAI GPT-5.6 Luna, Geo profile list prices per 1M tokens, read 2026-09-21. Estimate only.',
  shortContextMaxInputTokens: 272_000,
  short: { input: 220_000, cacheWrite: 275_000, cacheRead: 22_000, output: 1_320_000 },
  long: { input: 440_000, cacheWrite: 550_000, cacheRead: 44_000, output: 1_980_000 },
};

// --- the connection record ------------------------------------------------------

const iso = z.string().datetime({ offset: true });
export const awsConnectionSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** Declared by the owner at setup. A bearer key cannot prove its account; see `accountEvidence`. */
  accountId: z.string().regex(/^\d{12}$/),
  region: z.literal('us-east-1'),
  baseUrl: z.literal(AWS_RESPONSES_ENDPOINTS['us-east-1']),
  modelId: z.enum([AWS_LUNA_MODEL]),
  /** The Geo profile keeps processing inside US AWS Regions. */
  processing: z.literal('us-geo'),
  credential: z.strictObject({
    kind: z.literal('bedrock-api-key'),
    fingerprint: z.string().regex(/^[a-f0-9]{12}$/),
    savedAt: iso,
    /** A pasted short-term key does not renew itself. Null means the owner gave no expiry. */
    expiresAt: iso.nullable(),
  }),
  /** Bumped by every credential or scope change; part of the account route, so it fences results. */
  revision: z.number().int().min(1),
  createdAt: iso,
  updatedAt: iso,
});
export type AwsConnection = z.infer<typeof awsConnectionSchema>;

/** What Settings and every run carry. Identifiers only; never the key or the account number. */
export const awsAccountRoute = (connection: Pick<AwsConnection, 'id' | 'revision'>) =>
  `${AWS_BEDROCK_ROUTE}:${connection.id}@r${connection.revision}`;
export const redactedAccount = (accountId: string) => `••••${accountId.slice(-4)}`;
export const accountEvidence =
  'Account declared by the owner at setup. A Bedrock API key does not report its account, so Diomedes records the declared account and the key fingerprint, not a verified identity.';

/** The one connection this first slice supports, kept as a plain record beside the other data. */
export class AwsConnections {
  constructor(private readonly dataDir: string) {}
  private get file() {
    return path.join(this.dataDir, 'connections', `${AWS_BEDROCK_ROUTE}.json`);
  }
  async read(): Promise<AwsConnection | null> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    const parsed = awsConnectionSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw new HarnessError('connection_corrupt', 'The saved AWS connection record is not readable.');
    return parsed.data;
  }
  async write(connection: AwsConnection): Promise<AwsConnection> {
    const parsed = awsConnectionSchema.parse(connection);
    await jsonWrite(this.file, parsed);
    return parsed;
  }
  async remove(): Promise<void> {
    try {
      await fs.unlink(this.file);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

// --- the guarded transport ----------------------------------------------------------

/** What the transport saw, kept for classification. */
export type ResponsesEnvelope = StreamEnvelope;

const AWS_REQUEST_ID_HEADERS = ['x-amzn-requestid', 'x-request-id'] as const;

/** Only the saved Bedrock key reaches AWS, as a bearer token, after the destination checks. */
function attachBedrockKey(headers: Headers, secret: string) {
  headers.delete('authorization');
  headers.delete('openai-organization');
  headers.delete('openai-project');
  headers.set('authorization', `Bearer ${secret}`);
}

/**
 * The only fetch the SDK is given. It attaches the credential after checking
 * the exact origin and path, refuses redirects, bounds both directions and
 * keeps the raw stream so classification never depends on what the SDK's
 * schema happens to accept.
 */
export function guardedResponsesFetch(options: {
  baseUrl: string;
  secret: string;
  maxRequestBytes: number;
  maxResponseBytes: number;
  signal: AbortSignal;
  transport?: typeof globalThis.fetch;
  onDispatch: () => void;
  onEnvelope: (envelope: ResponsesEnvelope) => void;
}): typeof globalThis.fetch {
  return guardedStreamFetch({
    prefix: 'aws',
    label: 'AWS',
    expectedUrl: `${options.baseUrl}/responses`,
    attach: attachBedrockKey,
    requestIdHeaders: AWS_REQUEST_ID_HEADERS,
    ...options,
  });
}

// --- one call -----------------------------------------------------------------------

/** The AWS route's part of a call: its SDK instance, its endpoint and its reading of the stream. */
export function awsBinding(connection: AwsConnection, effort: 'low' | 'medium' | 'high'): RouteBinding {
  return {
    route: AWS_BEDROCK_ROUTE,
    prefix: 'aws',
    label: 'AWS',
    connectionId: connection.id,
    modelId: connection.modelId,
    expiresAt: connection.credential.expiresAt,
    model: (fetch) =>
      createOpenAI({
        name: AWS_BEDROCK_ROUTE,
        baseURL: connection.baseUrl,
        // A placeholder: the guarded transport attaches the real credential after its checks,
        // and an explicit value also stops the SDK reading OPENAI_API_KEY from the environment.
        apiKey: CREDENTIAL_PLACEHOLDER,
        fetch,
      }).responses(connection.modelId),
    guard: {
      expectedUrl: `${connection.baseUrl}/responses`,
      attach: attachBedrockKey,
      requestIdHeaders: AWS_REQUEST_ID_HEADERS,
    },
    providerOptions: {
      openai: {
        // The prefixed Geo model id does not match the SDK's `gpt-N` pattern, so the SDK
        // would treat it as a non-reasoning model: plain system role, no reasoning options and
        // no encrypted reasoning under store:false. These four lines state what it cannot infer.
        forceReasoning: true,
        systemMessageMode: 'developer',
        include: ['reasoning.encrypted_content'],
        reasoningEffort: effort,
        reasoningSummary: null,
        store: false,
        parallelToolCalls: false,
      },
    },
    classify: (envelope) => {
      const { readable, body } = responsesBody(envelope);
      return { readable, classified: readable ? classifyEnvelope(body) : null };
    },
    usage: responsesUsage,
  };
}

/**
 * One provider exchange: reserve, stream once, classify, settle. Never retried.
 * Throws `ModelApiError` for everything that is not a complete, valid answer or
 * a single, offered tool call.
 */
export async function respondOnce(
  input: {
    connection: AwsConnection;
    secret: string;
    card: ModelRateCard;
    exposure: SpendExposure;
    attempt: ExposureAttempt;
    instructions: string;
    messages: ModelMessage[];
    tools: readonly ToolDescriptor[];
    effort: 'low' | 'medium' | 'high';
    limits: RespondLimits;
    signal: AbortSignal;
    transport?: typeof globalThis.fetch;
    now?: () => Date;
  } & StreamSinks,
): Promise<RespondResult> {
  const connection = awsConnectionSchema.parse(input.connection);
  const { connection: _connection, effort, ...rest } = input;
  return respondStream({ ...rest, binding: awsBinding(connection, effort) });
}

/** A spend hold's identity, fixed before anything is sent. */
export function exposureAttempt(runId: string, stepId: string, request: unknown): ExposureAttempt {
  return { runId, stepId, attempt: 1, requestDigest: digest(request) };
}

/** Zero is a valid cap: it admits nothing until the owner approves an amount. */
export const NO_EXPOSURE = micro(0);
