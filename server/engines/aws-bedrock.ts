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
 * The conversation's tool loop is `NativeAgent`'s; its adapter lives in
 * `server/harness/aws-model-adapter.ts` and calls `respondOnce` here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, jsonSchema, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Json, ToolDescriptor } from '../../shared/harness.js';
import { micro } from '../../shared/managed-usage.js';
import { digest, HarnessError } from '../harness/policy.js';
import { secretScrubber } from '../secrets.js';
import {
  ceilingCost,
  type ExposureAttempt,
  type ExposureReservation,
  type ModelRateCard,
  type ProviderUsage,
  type SpendExposure,
} from '../spend-exposure.js';
import { jsonWrite } from '../store.js';

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

// --- errors -----------------------------------------------------------------------

/**
 * A refused or failed model-API call. `dispatched` is the fact that matters to
 * recovery: false means the request provably never left this process.
 */
export class ModelApiError extends HarnessError {
  constructor(
    code: string,
    message: string,
    readonly dispatched: boolean,
    readonly evidence: {
      reservation?: Pick<ExposureReservation, 'id' | 'state' | 'maxMicroUsd' | 'settledMicroUsd'> | null;
      status?: number | null;
      providerRequestId?: string | null;
      responseId?: string | null;
      partialText?: string | null;
    } = {},
  ) {
    super(code, message);
    this.name = 'ModelApiError';
  }
}

// --- the guarded transport ----------------------------------------------------------

/** What the transport saw, kept for classification. Bounded; the body is parsed data, never executed. */
export interface ResponsesEnvelope {
  status: number;
  bytes: number;
  body: unknown;
  readable: boolean;
  providerRequestId: string | null;
}

const RELEASABLE_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429]);
const CREDENTIAL_PLACEHOLDER = 'diomedes-guarded-credential';

/**
 * The only fetch the SDK is given. It attaches the credential after checking
 * the exact origin and path, refuses redirects, bounds both directions and
 * captures the raw body so classification never depends on what the SDK's
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
  const expected = new URL(`${options.baseUrl}/responses`);
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new ModelApiError(
        'aws_destination_refused',
        'The model request was addressed somewhere other than the approved AWS endpoint. Nothing was sent.',
        false,
      );
    if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || typeof init?.body !== 'string')
      throw new ModelApiError('aws_request_refused', 'Only one JSON POST is allowed on this route.', false);
    if (Buffer.byteLength(init.body) > options.maxRequestBytes)
      throw new ModelApiError(
        'aws_input_too_large',
        'This request is larger than the route allows. Nothing was sent.',
        false,
      );
    options.signal.throwIfAborted();
    const headers = new Headers(init.headers);
    // The SDK was given a placeholder key; the real credential is attached here, after the checks.
    headers.delete('authorization');
    headers.delete('openai-organization');
    headers.delete('openai-project');
    headers.set('authorization', `Bearer ${options.secret}`);
    headers.set('content-type', 'application/json');
    options.onDispatch();
    const response = await (options.transport ?? globalThis.fetch)(url, {
      method: 'POST',
      headers,
      body: init.body,
      redirect: 'error',
      signal: init.signal ?? options.signal,
    });
    if (response.redirected || (response.status >= 300 && response.status < 400))
      throw new ModelApiError(
        'aws_redirect_refused',
        'AWS answered with a redirect, which this route never follows.',
        true,
        { status: response.status },
      );
    // A stop can land while the response is on its way in, before anything below subscribes.
    if (options.signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      options.signal.throwIfAborted();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      const stop = () => void reader.cancel().catch(() => undefined);
      options.signal.addEventListener('abort', stop, { once: true });
      // An abort event that fired before this listener existed is never delivered to it.
      if (options.signal.aborted) stop();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > options.maxResponseBytes) {
            await reader.cancel().catch(() => undefined);
            throw new ModelApiError(
              'aws_output_too_large',
              'The AWS response exceeded this route’s size limit.',
              true,
              { status: response.status },
            );
          }
          chunks.push(part.value);
        }
      } finally {
        options.signal.removeEventListener('abort', stop);
        reader.releaseLock();
      }
    }
    options.signal.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    let body: unknown = null;
    let readable = false;
    try {
      body = JSON.parse(bytes.toString('utf8'));
      readable = true;
    } catch {
      readable = false;
    }
    options.onEnvelope({
      status: response.status,
      bytes: bytes.byteLength,
      body,
      readable,
      providerRequestId:
        response.headers.get('x-amzn-requestid') ?? response.headers.get('x-request-id') ?? null,
    });
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// --- classification -----------------------------------------------------------------

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  input_tokens_details: z
    .object({ cached_tokens: count.nullish(), cache_write_tokens: count.nullish() })
    .nullish(),
  output_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish(),
});

/** Provider usage in the ledger's structure: cache reads and writes and reasoning stay distinct. */
export function providerUsage(raw: unknown): ProviderUsage | null {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const usage: ProviderUsage = {
    inputTokens: parsed.data.input_tokens,
    cacheReadTokens: parsed.data.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: parsed.data.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: parsed.data.output_tokens,
    reasoningTokens: parsed.data.output_tokens_details?.reasoning_tokens ?? 0,
  };
  if (
    usage.cacheReadTokens + usage.cacheWriteTokens > usage.inputTokens ||
    usage.reasoningTokens > usage.outputTokens
  )
    return null;
  return usage;
}

export interface ClassifiedEnvelope {
  status: string | null;
  responseId: string | null;
  reportedModel: string | null;
  usage: ProviderUsage | null;
  text: string;
  refusal: string | null;
  functionCalls: { callId: string; name: string; arguments: string }[];
  unexpectedItems: string[];
  incompleteReason: string | null;
  providerError: { code: string | null; message: string } | null;
}

const bounded = (text: string, max = 2_000) => (text.length > max ? `${text.slice(0, max)}…` : text);
const str = (value: unknown) => (typeof value === 'string' ? value : null);

/** Reads a Responses object as data. Nothing in it can widen what the route will do. */
export function classifyEnvelope(body: unknown): ClassifiedEnvelope {
  const object = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const result: ClassifiedEnvelope = {
    status: str(object.status),
    responseId: str(object.id) || null,
    reportedModel: str(object.model) || null,
    usage: providerUsage(object.usage),
    text: '',
    refusal: null,
    functionCalls: [],
    unexpectedItems: [],
    incompleteReason: null,
    providerError: null,
  };
  const incomplete = object.incomplete_details as { reason?: unknown } | null | undefined;
  result.incompleteReason = str(incomplete?.reason);
  const error = object.error as { code?: unknown; message?: unknown } | null | undefined;
  if (error && typeof error === 'object')
    result.providerError = { code: str(error.code), message: bounded(str(error.message) ?? 'Unknown provider error.') };
  const output = Array.isArray(object.output) ? object.output : [];
  for (const item of output) {
    const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    switch (entry.type) {
      case 'reasoning':
        break;
      case 'message': {
        const content = Array.isArray(entry.content) ? entry.content : [];
        for (const part of content) {
          const piece = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
          if (piece.type === 'output_text' && typeof piece.text === 'string') result.text += piece.text;
          else if (piece.type === 'refusal')
            result.refusal ??= bounded(str(piece.refusal) ?? 'The model declined.');
          else result.unexpectedItems.push(`message:${String(piece.type)}`);
        }
        break;
      }
      case 'function_call': {
        // Only a direct, synchronous, un-namespaced call to an offered function is a tool
        // request here. Program-driven, asynchronous or namespaced calls are other contracts.
        const caller = entry.caller as { type?: unknown } | null | undefined;
        if ((caller != null && caller.type !== 'direct') || entry.async === true || entry.namespace != null) {
          result.unexpectedItems.push('function_call:non-direct');
          break;
        }
        result.functionCalls.push({
          callId: str(entry.call_id) ?? '',
          name: str(entry.name) ?? '',
          arguments: str(entry.arguments) ?? '',
        });
        break;
      }
      default:
        result.unexpectedItems.push(String(entry.type));
    }
  }
  return result;
}

// --- one call -----------------------------------------------------------------------

export interface RespondLimits {
  maxOutputTokens: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** Enforced here, per call, because the run budget's wallMs is recorded, not enforced. */
  callWallMs: number;
}
export const CONVERSATION_LIMITS: RespondLimits = {
  maxOutputTokens: 4_096,
  maxRequestBytes: 200_000,
  maxResponseBytes: 1_048_576,
  callWallMs: 120_000,
};
export const WORK_LIMITS: RespondLimits = {
  maxOutputTokens: 16_384,
  maxRequestBytes: 400_000,
  maxResponseBytes: 2_097_152,
  callWallMs: 240_000,
};

export type RespondOutcome =
  | { kind: 'final'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: Json };

export interface RespondResult {
  outcome: RespondOutcome;
  usage: ProviderUsage;
  reportedModel: string | null;
  responseId: string | null;
  providerRequestId: string | null;
  /** The SDK's provider-format messages for this exchange: private continuation state. */
  responseMessages: ModelMessage[];
  reservation: ExposureReservation;
  warnings: number;
}

/** The input-token ceiling a request can reach, from its bytes: a token never covers less than one byte. */
export function inputTokenBound(bytes: number, messages: number) {
  return bytes + 1_024 + messages * 16;
}

/**
 * One provider exchange: reserve, send once, classify, settle. Never retried.
 * Throws `ModelApiError` for everything that is not a complete, valid answer or
 * a single, offered tool call.
 */
export async function respondOnce(input: {
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
}): Promise<RespondResult> {
  const connection = awsConnectionSchema.parse(input.connection);
  const now = input.now ?? (() => new Date());
  const scrub = secretScrubber([input.secret]);
  if (input.card.route !== AWS_BEDROCK_ROUTE || input.card.modelId !== connection.modelId)
    throw new ModelApiError('aws_rate_card_mismatch', 'No rate card is approved for this model.', false);
  if (
    connection.credential.expiresAt &&
    Date.parse(connection.credential.expiresAt) <= now().getTime() + 60_000
  )
    throw new ModelApiError(
      'aws_credential_expired',
      'The saved AWS key has expired or is about to. A pasted short-term key does not renew itself; enter a new one in AI setup.',
      false,
    );
  const tools: ToolSet = {};
  if (input.tools.length > 16)
    throw new ModelApiError('aws_invalid_tools', 'This call offers too many tools.', false);
  for (const descriptor of input.tools) {
    const schema = descriptor.inputSchema as Record<string, unknown> | null;
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(descriptor.name) ||
      Object.hasOwn(tools, descriptor.name) ||
      !schema ||
      typeof schema !== 'object' ||
      Array.isArray(schema) ||
      schema.type !== 'object'
    )
      throw new ModelApiError(
        'aws_invalid_tools',
        'Each offered tool needs a unique function name and an object schema.',
        false,
      );
    // A descriptor only: no `execute`, so the SDK can never run it.
    Object.defineProperty(tools, descriptor.name, {
      enumerable: true,
      value: {
        description: descriptor.description,
        inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
      },
    });
  }
  const estimateBytes = Buffer.byteLength(
    JSON.stringify({ instructions: input.instructions, messages: input.messages, tools: input.tools }),
  );
  if (estimateBytes > input.limits.maxRequestBytes)
    throw new ModelApiError(
      'aws_input_too_large',
      'The conversation and its sources are larger than this route allows. Nothing was sent.',
      false,
    );
  const maxInputTokens = inputTokenBound(estimateBytes, input.messages.length + 1);
  const ceiling = ceilingCost(input.card, {
    maxInputTokens,
    maxOutputTokens: input.limits.maxOutputTokens,
  });
  let reservation: ExposureReservation;
  try {
    reservation = await input.exposure.reserve({
      connectionId: connection.id,
      route: AWS_BEDROCK_ROUTE,
      modelId: connection.modelId,
      card: input.card,
      attempt: input.attempt,
      maxMicroUsd: ceiling,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'spend_refused';
    const message = error instanceof Error ? error.message : 'The spend limit refused this call.';
    throw new ModelApiError(
      code === 'attempt_exists' ? 'aws_attempt_exists' : 'aws_spend_refused',
      code === 'attempt_exists'
        ? 'This exact call was already attempted. It is never sent twice; check the run before continuing.'
        : `${message} Nothing was sent.`,
      false,
    );
  }
  let dispatched = false;
  let envelope: ResponsesEnvelope | null = null;
  const wall = AbortSignal.timeout(input.limits.callWallMs);
  const signal = AbortSignal.any([input.signal, wall]);
  const evidence = () => ({
    reservation: {
      id: reservation.id,
      state: reservation.state,
      maxMicroUsd: reservation.maxMicroUsd,
      settledMicroUsd: reservation.settledMicroUsd,
    },
    status: envelope?.status ?? null,
    providerRequestId: envelope?.providerRequestId ?? null,
  });
  /**
   * Settle from reported usage. A settle the ledger refuses or cannot persist leaves
   * the hold uncertain, never pending and never zero; a hold even that cannot
   * record is left for the startup sweep, which parks every pending hold.
   */
  const settleOrLose = async (usage: ProviderUsage, why: string) => {
    try {
      reservation = await input.exposure.settle(reservation.id, {
        usage,
        card: input.card,
        providerRequestId: envelope?.providerRequestId ?? null,
      });
      return true;
    } catch {
      try {
        reservation = await input.exposure.markUncertain(
          reservation.id,
          `Sent, and AWS reported usage, but it could not be recorded (${why}). The cost is unknown until reconciled.`,
        );
      } catch {
        // The sweep at the next start turns this pending hold uncertain.
      }
      return false;
    }
  };
  /** Resolves the hold from what is known, then throws. Missing usage is never zero. */
  const fail = async (code: string, message: string, extra: { partialText?: string | null; responseId?: string | null } = {}): Promise<never> => {
    const usage = envelope?.readable ? providerUsage((envelope.body as { usage?: unknown })?.usage) : null;
    try {
      if (!dispatched) reservation = await input.exposure.release(reservation.id, `Not sent: ${code}.`);
      else if (usage) await settleOrLose(usage, code);
      else if (envelope && RELEASABLE_STATUSES.has(envelope.status) && envelope.readable)
        // A provider rejection with an error body is a refusal before inference, not a lost answer.
        reservation = await input.exposure.release(reservation.id, `AWS refused the request with HTTP ${envelope.status}.`);
      else
        reservation = await input.exposure.markUncertain(
          reservation.id,
          `Sent, but no usage came back (${code}). The cost is unknown until reconciled.`,
        );
    } catch {
      // A hold that cannot be resolved stays pending on disk; the startup sweep parks it
      // uncertain. The call's own failure is still the one reported.
    }
    throw new ModelApiError(code, scrub(message), dispatched, { ...evidence(), ...extra });
  };

  let sdk: Awaited<ReturnType<typeof generateText>> | null = null;
  let sdkError: unknown = null;
  try {
    const provider = createOpenAI({
      name: AWS_BEDROCK_ROUTE,
      baseURL: connection.baseUrl,
      // A placeholder: the guarded transport attaches the real credential after its checks,
      // and an explicit value also stops the SDK reading OPENAI_API_KEY from the environment.
      apiKey: CREDENTIAL_PLACEHOLDER,
      fetch: guardedResponsesFetch({
        baseUrl: connection.baseUrl,
        secret: input.secret,
        maxRequestBytes: input.limits.maxRequestBytes,
        maxResponseBytes: input.limits.maxResponseBytes,
        signal,
        transport: input.transport,
        onDispatch: () => {
          dispatched = true;
        },
        onEnvelope: (value) => {
          envelope = value;
        },
      }),
    });
    sdk = await generateText({
      model: provider.responses(connection.modelId),
      system: input.instructions,
      messages: input.messages,
      tools,
      toolChoice: 'auto',
      maxOutputTokens: input.limits.maxOutputTokens,
      maxRetries: 0,
      stopWhen: stepCountIs(1),
      abortSignal: signal,
      providerOptions: {
        openai: {
          // The prefixed Geo model id does not match the SDK's `gpt-N` pattern, so the SDK
          // would treat it as a non-reasoning model: plain system role, no reasoning options and
          // no encrypted reasoning under store:false. These four lines state what it cannot infer.
          forceReasoning: true,
          systemMessageMode: 'developer',
          include: ['reasoning.encrypted_content'],
          reasoningEffort: input.effort,
          reasoningSummary: null,
          store: false,
          parallelToolCalls: false,
        },
      },
    });
  } catch (error) {
    sdkError = error;
  }
  if (!dispatched) {
    if (sdkError instanceof ModelApiError) return fail(sdkError.code, sdkError.message);
    return fail('aws_request_not_prepared', 'The model request could not be prepared. Nothing was sent.');
  }
  if (signal.aborted && !envelope)
    return fail(
      wall.aborted ? 'aws_timeout' : 'aws_cancelled',
      wall.aborted
        ? 'AWS did not answer within this route’s time limit. The request was sent; its cost is unknown until reconciled.'
        : 'Stopped after the request was sent. AWS may still have processed it; its cost is unknown until reconciled.',
    );
  if (!envelope)
    return fail(
      sdkError instanceof ModelApiError ? sdkError.code : 'aws_unknown_outcome',
      'The request was sent but no complete answer came back. Check this run before retrying.',
    );
  const seen = envelope as ResponsesEnvelope;
  if (signal.aborted)
    return fail(
      wall.aborted ? 'aws_timeout' : 'aws_cancelled',
      'Stopped after AWS answered. The answer was not used; its reported usage is recorded.',
    );
  if (!seen.readable)
    return fail('aws_unreadable_response', 'AWS returned a response Diomedes could not read. Nothing from it was used.');
  const classified = classifyEnvelope(seen.body);
  const partialText = classified.text ? bounded(classified.text) : null;
  const common = { responseId: classified.responseId };
  if (seen.status >= 400 || classified.providerError)
    return fail(
      seen.status >= 500 ? 'aws_provider_error' : 'aws_provider_refused',
      `AWS returned an error${classified.providerError?.message ? `: ${classified.providerError.message}` : '.'}`,
      common,
    );
  if (classified.status === 'incomplete')
    return fail(
      classified.incompleteReason === 'content_filter' ? 'aws_refused' : 'aws_incomplete_output',
      classified.incompleteReason === 'max_output_tokens'
        ? 'The answer stopped at the output limit before it was complete. The partial text is kept as evidence, not as an answer.'
        : `AWS stopped before the answer was complete (${classified.incompleteReason ?? 'no reason given'}).`,
      { ...common, partialText },
    );
  if (classified.status !== 'completed')
    return fail('aws_not_completed', `AWS reported the response as ${classified.status ?? 'unknown'}, not completed.`, common);
  if (classified.refusal)
    return fail('aws_refused', 'The model declined this request.', { ...common, partialText: classified.refusal });
  if (classified.unexpectedItems.length)
    return fail(
      'aws_unexpected_output',
      'AWS returned output this route does not accept. Nothing from it was used.',
      common,
    );
  if (classified.functionCalls.length > 1)
    return fail(
      'aws_multiple_tools',
      'The model asked for more than one tool at once. None of them were run.',
      common,
    );
  if (!classified.usage)
    return fail('aws_usage_missing', 'AWS did not report usage for a completed answer. Its cost is unknown until reconciled.', common);
  if (sdkError || !sdk)
    return fail('aws_invalid_output', 'The AWS answer did not pass the SDK’s own validation. Nothing from it was used.', common);
  let outcome: RespondOutcome;
  const call = classified.functionCalls[0];
  if (call) {
    const offered = input.tools.some((tool) => tool.name === call.name);
    const sdkCall = sdk.toolCalls[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      parsed = undefined;
    }
    if (
      !offered ||
      !call.callId ||
      sdk.toolCalls.length !== 1 ||
      ('invalid' in sdkCall && sdkCall.invalid === true) ||
      sdkCall.toolCallId !== call.callId ||
      sdkCall.toolName !== call.name ||
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    )
      return fail('aws_invalid_tool', 'The model named a tool call this turn did not offer, or its arguments were malformed. It was not run.', common);
    outcome = { kind: 'tool', callId: call.callId, name: call.name, input: z.json().parse(parsed) as Json };
  } else {
    if (!classified.text.trim()) return fail('aws_empty_output', 'AWS returned no answer.', common);
    if (sdk.toolCalls.length || sdk.text !== classified.text)
      return fail('aws_invalid_output', 'The SDK’s reading of the answer differs from AWS’s response. Nothing was used.', common);
    outcome = { kind: 'final', text: classified.text };
  }
  if (!(await settleOrLose(classified.usage, 'settle refused')))
    // Fail closed: an answer whose cost is not on the ledger is not used.
    throw new ModelApiError(
      'aws_usage_unrecorded',
      'AWS answered, but Diomedes could not record what it cost. The answer was not used; the call is held as uncertain.',
      true,
      { ...evidence(), responseId: classified.responseId },
    );
  return {
    outcome,
    usage: classified.usage,
    reportedModel: classified.reportedModel,
    responseId: classified.responseId,
    providerRequestId: seen.providerRequestId,
    responseMessages: structuredClone(sdk.response.messages) as ModelMessage[],
    reservation,
    warnings: sdk.warnings?.length ?? 0,
  };
}

/** A spend hold's identity, fixed before anything is sent. */
export function exposureAttempt(runId: string, stepId: string, request: unknown): ExposureAttempt {
  return { runId, stepId, attempt: 1, requestDigest: digest(request) };
}

/** Zero is a valid cap: it admits nothing until the owner approves an amount. */
export const NO_EXPOSURE = micro(0);
