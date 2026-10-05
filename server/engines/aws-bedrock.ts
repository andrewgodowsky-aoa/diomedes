/**
 * The direct AWS Bedrock route (SDKR-AWS-01, amended by SDKR-CONN-02).
 *
 * One explicitly selected route: the Bedrock runtime's OpenAI-compatible
 * endpoints in us-east-1, the Geo inference profile
 * `us.openai.gpt-5.6-luna` by default, the company's own AWS account, `store: false`, one
 * provider exchange per call and no fallback of any kind. There is no Gateway,
 * no bare model string, no ambient `OPENAI_API_KEY` or AWS environment
 * variable, no SDK retry and no SDK tool executor: every tool the model may
 * name is a descriptor, and the Diomedes harness is the only thing that runs it.
 *
 * Each approved model has one protocol (`AWS_MODEL_PROTOCOLS`): Luna goes over Responses and the
 * published US Kimi K3 profile over Chat Completions. K3 sends only under a current route check
 * receipt (`route-qualification.ts`) for this exact connection revision, model, protocol and rate
 * card, because its billed reasoning and output envelope is proven per connection by those
 * checks, never assumed from a catalog row.
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
import {
  AWS_DIRECT_MODEL_IDS,
  AWS_KIMI_K3,
  AWS_KIMI_K3_REFUSAL,
  awsModelProtocol,
  MANAGED_LUNA,
} from '../../shared/model-api.js';
import {
  receiptQualifies,
  type QualificationIdentity,
  type QualificationProtocol,
  type RouteQualificationReceipt,
} from '../../shared/route-qualification.js';
import { digest, HarnessError } from '../harness/policy.js';
import type { ExposureAttempt, ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { jsonWrite } from '../store.js';
import { chatEnvelopeUsage, classifyChat } from './chat-completions.js';
import { withCacheOptions, type QualificationTarget } from './route-qualification.js';
import type { RouteQualifications } from './route-qualification-store.js';
import {
  classifyEnvelope,
  CREDENTIAL_PLACEHOLDER,
  guardedStreamFetch,
  ModelApiError,
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
/** The protocol Kimi K3 is sent over, on the same runtime base. */
export const AWS_CHAT_PROTOCOL = 'openai-chat-completions';
export const AWS_LUNA_MODEL = MANAGED_LUNA.model;
export const AWS_KIMI_K3_MODEL = AWS_KIMI_K3.model;
/**
 * Models an earlier version saved a connection for. Such a record is read as retired: the
 * owner reconnects, and nothing is sent on it or silently moved to the current model.
 */
export const AWS_RETIRED_MODELS: readonly string[] = ['us.openai.gpt-6-luna'];
export const AWS_RECONNECT =
  'The saved AWS Bedrock connection is for GPT-6 Luna, which this version no longer runs. Reconnect AWS Bedrock with GPT-5.6 Luna in AI setup.';
/**
 * The runtime endpoint the Luna and Kimi K3 model cards pair with US Geo profiles. The
 * Luna-specific Mantle base (`bedrock-mantle…/openai/v1`, model
 * `openai.gpt-5.6-luna`) is a different route with its own identity; it is not
 * accepted here and is never substituted.
 */
export const AWS_RESPONSES_ENDPOINTS = {
  'us-east-1': 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
} as const;
export type AwsRegion = keyof typeof AWS_RESPONSES_ENDPOINTS;
/**
 * Reviewed catalog identities, not proof of account access or call qualification.
 * The runtime has no OpenAI `GET /models`, and an
 * invoke-only key may not be allowed to enumerate the Bedrock catalog, so the
 * route uses this explicit, vetted list rather than calling a key invalid.
 */
export const AWS_VETTED_MODELS: Record<AwsRegion, readonly string[]> = {
  'us-east-1': AWS_DIRECT_MODEL_IDS,
};

/**
 * List prices from the AWS model card for the US Geo profile, from the one registry row
 * (`MANAGED_LUNA`) the Nectovia route's local guard prices with: an application estimate of
 * gross cost, never an invoice and never a statement about promotional credit.
 * The owner's route uses the published higher band for long-context input.
 */
export const AWS_LUNA_RATE_CARD: ModelRateCard = {
  version: MANAGED_LUNA.rateCard,
  route: AWS_BEDROCK_ROUTE,
  modelId: AWS_LUNA_MODEL,
  source: MANAGED_LUNA.source,
  shortContextMaxInputTokens: MANAGED_LUNA.maxInputTokens,
  short: { ...MANAGED_LUNA.rates },
  long: { ...MANAGED_LUNA.longRates },
};

/** Published US Geo Standard estimate; no Global or Priority price is substituted. */
export const AWS_KIMI_K3_RATE_CARD: ModelRateCard = {
  version: AWS_KIMI_K3.rateCard,
  route: AWS_BEDROCK_ROUTE,
  modelId: AWS_KIMI_K3_MODEL,
  source: AWS_KIMI_K3.source,
  // Flat-price ledger convention (declaredRateCard): a local band marker, not a provider context limit.
  shortContextMaxInputTokens: 10_000_000,
  short: { ...AWS_KIMI_K3.rates },
  long: { ...AWS_KIMI_K3.rates },
};

const unknownModel = () =>
  new ModelApiError('aws_unknown_model', 'This model is not an approved AWS Bedrock selection. Nothing was sent.', false);

/** Prices the exact saved direct route selection. Unknown identities fail instead of using Luna's price. */
export function awsModelRateCard(modelId: string): ModelRateCard {
  if (modelId === AWS_LUNA_MODEL) return AWS_LUNA_RATE_CARD;
  if (modelId === AWS_KIMI_K3_MODEL) return AWS_KIMI_K3_RATE_CARD;
  throw unknownModel();
}

/** The one protocol an approved model is sent over on this route. Unknown identities fail. */
export function awsProtocolFor(modelId: string): QualificationProtocol {
  const protocol = awsModelProtocol(modelId);
  if (!protocol) throw unknownModel();
  return protocol;
}

// --- the receipt gate ------------------------------------------------------------------

/**
 * Whether a model sends only under a route check receipt. A published catalog row is not a
 * qualified billing envelope for this adapter; a passing route check on this connection is.
 */
export const awsRequiresQualification = (modelId: string) => modelId === AWS_KIMI_K3_MODEL;

/** What a receipt must match, field for field, for this connection's model to send. */
export function awsQualificationIdentity(
  connection: Pick<AwsConnection, 'id' | 'revision' | 'modelId'>,
  rateCard: string = awsModelRateCard(connection.modelId).version,
): QualificationIdentity {
  return {
    route: AWS_BEDROCK_ROUTE,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    model: connection.modelId,
    protocol: awsProtocolFor(connection.modelId),
    rateCard,
    deployment: null,
  };
}

/**
 * Why a call on this connection's model may not send, or null when it may. Unknown identities
 * throw. A model that needs a receipt is refused in one sentence unless the receipt qualifies this
 * exact identity now; the specific reason is the route checks' to show. `rateCard` is the version
 * the call is priced with, so a receipt never covers another price.
 */
export function awsModelRefusal(
  connection: Pick<AwsConnection, 'id' | 'revision' | 'modelId'>,
  qualification: RouteQualificationReceipt | null | undefined,
  now: number,
  rateCard?: string,
): string | null {
  const card = awsModelRateCard(connection.modelId); // Also refuses unknown model identities.
  if (!awsRequiresQualification(connection.modelId)) return null;
  const verdict = receiptQualifies(qualification, awsQualificationIdentity(connection, rateCard ?? card.version), now);
  return verdict.ok ? null : AWS_KIMI_K3_REFUSAL;
}

/** Runs before any spend reservation, SDK preparation, or credential-bearing dispatch. */
export function assertAwsModelQualified(
  connection: Pick<AwsConnection, 'id' | 'revision' | 'modelId'>,
  qualification: RouteQualificationReceipt | null | undefined,
  now: number,
  rateCard?: string,
): void {
  const refusal = awsModelRefusal(connection, qualification, now, rateCard);
  if (refusal) throw new ModelApiError('aws_model_unqualified', `${refusal} Nothing was sent.`, false);
}

/**
 * The receipt a call on this connection is judged by: the newest one recorded for this connection
 * and model, read only when the model needs one. No store, or an unreadable one, reads as none.
 */
export async function awsQualificationFor(
  receipts: Pick<RouteQualifications, 'latest'> | undefined,
  connection: Pick<AwsConnection, 'id' | 'modelId'>,
): Promise<RouteQualificationReceipt | null> {
  if (!receipts || !awsRequiresQualification(connection.modelId)) return null;
  return receipts.latest(AWS_BEDROCK_ROUTE, connection.id, { model: connection.modelId });
}

// --- the connection record ------------------------------------------------------

const iso = z.string().datetime({ offset: true });
export const awsConnectionSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** Declared by the owner at setup. A bearer key cannot prove its account; see `accountEvidence`. */
  accountId: z.string().regex(/^\d{12}$/),
  region: z.literal('us-east-1'),
  baseUrl: z.literal(AWS_RESPONSES_ENDPOINTS['us-east-1']),
  modelId: z.enum(AWS_DIRECT_MODEL_IDS),
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

/**
 * A saved connection that is valid in every way except that it names a retired model. It
 * carries the revision it reached so a reconnect keeps counting up, and a result from a
 * call made under it is still refused.
 */
export class AwsConnectionRetired extends HarnessError {
  constructor(readonly retired: Pick<AwsConnection, 'revision' | 'createdAt'>) {
    super('connection_retired', AWS_RECONNECT);
  }
}
function retiredConnection(raw: unknown): Pick<AwsConnection, 'revision' | 'createdAt'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const modelId = (raw as { modelId?: unknown }).modelId;
  if (typeof modelId !== 'string' || !AWS_RETIRED_MODELS.includes(modelId)) return null;
  const parsed = awsConnectionSchema.safeParse({ ...raw, modelId: AWS_LUNA_MODEL });
  return parsed.success ? { revision: parsed.data.revision, createdAt: parsed.data.createdAt } : null;
}

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
    const raw: unknown = JSON.parse(text);
    const parsed = awsConnectionSchema.safeParse(raw);
    if (!parsed.success) {
      const retired = retiredConnection(raw);
      if (retired) throw new AwsConnectionRetired(retired);
      throw new HarnessError('connection_corrupt', 'The saved AWS connection record is not readable.');
    }
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

/**
 * The AWS route's part of a call, by the one protocol the connection's model is sent over: its SDK
 * instance, its endpoint and its reading of the stream.
 */
export function awsBinding(
  connection: AwsConnection,
  effort: 'low' | 'medium' | 'high',
  /** Whether a thinking sink is listening: summaries are asked for only then (Responses only). */
  summaries: boolean,
  /** The call's exact output limit; the Chat Completions request is checked against it. */
  maxOutputTokens: number,
): RouteBinding {
  return awsProtocolFor(connection.modelId) === AWS_CHAT_PROTOCOL
    ? awsChatBinding(connection, effort, maxOutputTokens)
    : awsResponsesBinding(connection, effort, summaries);
}

/** Luna over the Responses endpoint. */
export function awsResponsesBinding(
  connection: AwsConnection,
  effort: 'low' | 'medium' | 'high',
  summaries: boolean,
): RouteBinding {
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
        reasoningSummary: summaries ? 'auto' : null,
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
 * The serialized Chat Completions request names the admitted model, streams with a usage report,
 * and carries the call's exact output limit as `max_completion_tokens` with no `max_tokens` beside
 * it, so the one limit sent is the one the hold was reserved for. Fields this check does not name,
 * such as the route checks' `prompt_cache_options` and `prompt_cache_key`, pass.
 */
export function inspectAwsChatBody(modelId: string, maxOutputTokens: number) {
  return (text: string) => {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
    const usage = body?.stream_options;
    if (
      !body ||
      body.model !== modelId ||
      body.stream !== true ||
      !usage ||
      typeof usage !== 'object' ||
      (usage as Record<string, unknown>).include_usage !== true ||
      !Number.isInteger(body.max_completion_tokens) ||
      (body.max_completion_tokens as number) <= 0 ||
      body.max_completion_tokens !== maxOutputTokens ||
      body.max_tokens !== undefined
    )
      throw new ModelApiError(
        'aws_request_refused',
        'The request did not name the admitted model with a usage report and its exact output limit. Nothing was sent.',
        false,
      );
  };
}

/** Kimi K3 over the Chat Completions endpoint on the same runtime base. */
export function awsChatBinding(
  connection: AwsConnection,
  effort: 'low' | 'medium' | 'high',
  /** The call's exact output limit: the serialized request must carry exactly this. */
  maxOutputTokens: number,
): RouteBinding {
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
        apiKey: CREDENTIAL_PLACEHOLDER,
        fetch,
      }).chat(connection.modelId),
    guard: {
      expectedUrl: `${connection.baseUrl}/chat/completions`,
      attach: attachBedrockKey,
      inspectBody: inspectAwsChatBody(connection.modelId, maxOutputTokens),
      requestIdHeaders: AWS_REQUEST_ID_HEADERS,
    },
    providerOptions: {
      // The Chat Completions model reads only `openai`, whatever the provider instance is named.
      openai: {
        // The Geo model id does not match the SDK's reasoning-model pattern. Forcing reasoning
        // sends the limit as `max_completion_tokens` (reasoning and answer together) instead of
        // `max_tokens`, and keeps `reasoning_effort`. K3 takes the plain system role.
        forceReasoning: true,
        systemMessageMode: 'system',
        reasoningEffort: effort,
        // Sent even when no tool is offered; whether Bedrock accepts that here is shown by the
        // first route check, which offers none.
        parallelToolCalls: false,
        store: false,
      },
    },
    classify: classifyChat,
    usage: chatEnvelopeUsage,
  };
}

/**
 * The route checks' view of this connection: its exact identity and its own binding, the checks'
 * cache options under `openai`, the namespace the SDK reads for either protocol on this route.
 * The checks are the one path that sends a receipt model without a receipt, because they are how
 * it gets one; they run only on the owner's consent and inside this connection's spend limit.
 */
export function awsQualificationTarget(connection: AwsConnection, effort: 'low' | 'medium' | 'high'): QualificationTarget {
  const parsed = awsConnectionSchema.parse(connection);
  const card = awsModelRateCard(parsed.modelId);
  return {
    route: AWS_BEDROCK_ROUTE,
    connectionId: parsed.id,
    connectionRevision: parsed.revision,
    endpoint: parsed.baseUrl,
    deployment: null,
    model: parsed.modelId,
    protocol: awsProtocolFor(parsed.modelId),
    sdk: AWS_BEDROCK_SDK,
    rateCard: card.version,
    card,
    binding: (extra, maxOutputTokens) => withCacheOptions(awsBinding(parsed, effort, false, maxOutputTokens), 'openai', extra),
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
    /** The newest route check receipt for this connection. A model that needs one is refused without it. */
    qualification?: RouteQualificationReceipt | null;
  } & StreamSinks,
): Promise<RespondResult> {
  const connection = awsConnectionSchema.parse(input.connection);
  const now = (input.now ?? (() => new Date()))().getTime();
  assertAwsModelQualified(connection, input.qualification, now, input.card.version);
  const { connection: _connection, effort, qualification: _qualification, ...rest } = input;
  return respondStream({
    ...rest,
    binding: awsBinding(connection, effort, Boolean(rest.onReasoningDelta), rest.limits.maxOutputTokens),
  });
}

/** A spend hold's identity, fixed before anything is sent. */
export function exposureAttempt(runId: string, stepId: string, request: unknown): ExposureAttempt {
  return { runId, stepId, attempt: 1, requestDigest: digest(request) };
}

/** Zero is a valid cap: it admits nothing until the owner approves an amount. */
export const NO_EXPOSURE = micro(0);
