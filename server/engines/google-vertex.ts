/**
 * The Google Cloud Vertex AI route: Gemini 3.8 Flash on the company's own
 * Google Cloud project, reached through Vertex's `streamGenerateContent` on the
 * global endpoint, and billed to that project.
 *
 * This is a native model route, not an agent harness: NativeAgent owns the
 * loop, RunService owns each step, the registry owns every tool and Trust owns
 * authorization. One call is one streamed `generateContent` exchange through
 * the shared model-API core, with no SDK retry and descriptor-only tools.
 *
 * It is the Vertex route and nothing else. The request URL is built from the
 * saved project, the `global` location and the one approved model, and the
 * guarded transport refuses any other destination: the Gemini API (AI Studio)
 * host, an Express Mode API key, a partner model under `publishers/anthropic`
 * and any other project all fail before anything is sent. The SDK never loads
 * a credential: it is handed a placeholder client, and the real bearer token is
 * attached only after the destination checks, together with the project as
 * `x-goog-user-project`, so an ambient quota project cannot move the bill.
 *
 * The credential is Google Application Default Credentials from one exact file
 * (the owner's `gcloud auth application-default login`, or a file named by
 * GOOGLE_APPLICATION_CREDENTIALS), fingerprinted by its identity fields at
 * setup. A different ADC file at send time is a different credential and is
 * refused until the owner verifies it again. Nothing reads the metadata server,
 * and no token, refresh token or key is logged, saved or shown.
 */
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVertex } from '@ai-sdk/google-vertex';
import type { ModelMessage } from 'ai';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { ToolDescriptor } from '../../shared/harness.js';
import type { ExposureSummary, ModelRateCard, ProviderUsage } from '../spend-exposure.js';
import type { VertexAccountingView } from '../../shared/model-api.js';
import { ConnectionFile } from './connection-file.js';
import {
  bounded,
  CREDENTIAL_PLACEHOLDER,
  consistentUsage,
  ModelApiError,
  respondStream,
  str,
  type CallExposure,
  type ClassifiedEnvelope,
  type RespondLimits,
  type RespondResult,
  type RouteBinding,
  type StreamEnvelope,
  type StreamSinks,
} from './model-api-core.js';
import type { ExposureAttempt } from '../spend-exposure.js';

export const GOOGLE_VERTEX_ROUTE = 'google-vertex' as const;
/** The exact dependency set this route was written and tested against. */
export const GOOGLE_VERTEX_SDK =
  'ai@7.0.107+@ai-sdk/google-vertex@5.0.90+@ai-sdk/google@4.0.77+google-auth-library@10.9.1';
export const GOOGLE_VERTEX_PROTOCOL = 'vertex-v1-stream-generate-content';
export const VERTEX_CONNECTION_ID = 'google-vertex-1';
/** The one approved model. Its own name, never an alias, a `-latest` or a partner model. */
export const VERTEX_GEMINI_MODEL = 'gemini-3.8-flash' as const;
/** The one approved location: Google's global endpoint, priced at the Global rows. */
export const VERTEX_LOCATION = 'global' as const;
export const VERTEX_API_VERSION = 'v1' as const;
/** A Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. */
export const VERTEX_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export const vertexBaseUrl = (projectId: string) =>
  `https://aiplatform.googleapis.com/${VERTEX_API_VERSION}/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google`;
export const vertexStreamUrl = (projectId: string) =>
  `${vertexBaseUrl(projectId)}/models/${VERTEX_GEMINI_MODEL}:streamGenerateContent`;

// --- the rate cards -----------------------------------------------------------------

const PRICE_SOURCE =
  'https://cloud.google.com/vertex-ai/generative-ai/pricing, Gemini 3.8 Flash, Global, Standard (not Priority, not Flex) per 1M tokens, read 2026-09-23. The ≤200K and >200K columns are equal. Non-global endpoints cost 10% more and are not used. Google charges only for requests that return HTTP 200. Estimate only, never an invoice.';

/**
 * Google's prices for one period, with the dates they apply and the date after
 * which the evidence behind them is too old to keep pricing calls with.
 */
export interface DatedRateCard {
  card: ModelRateCard;
  /** Inclusive start, UTC. */
  from: string;
  /** Exclusive end, UTC, or null when Google has published no end. */
  until: string | null;
  /** After this, the figures must be read from Google's page again before another call is priced. */
  verifiedUntil: string;
}

const band = (input: number, cacheRead: number, output: number) => ({
  input,
  cacheRead,
  // Vertex's implicit caching has no write charge and this route creates no explicit cache;
  // a cache-write token is never expected, and if one appears it is priced as fresh input.
  cacheWrite: input,
  output,
});

/**
 * The gross card: Google's standard Global price, used for every date. Google's
 * page shows a lower "introductory" figure through 2026-12-31, but its footnote
 * says that figure is delivered as "50% credits back on net spend", so the
 * invoice line is at the standard rate and any credit arrives afterwards. A hold
 * and a settlement are therefore priced at the standard rate: a conservative
 * provider-cost bound that the expected promotion can only lower.
 */
export const VERTEX_RATE_CARDS: readonly DatedRateCard[] = Object.freeze([
  {
    card: {
      version: 'google-vertex:gemini-3.8-flash:global:standard:gross-2026.1',
      route: GOOGLE_VERTEX_ROUTE,
      modelId: VERTEX_GEMINI_MODEL,
      source: `${PRICE_SOURCE} Gross standard rate; the introductory credit-back is recorded separately and never lowers this estimate.`,
      shortContextMaxInputTokens: 200_000,
      short: band(1_500_000, 150_000, 7_500_000),
      long: band(1_500_000, 150_000, 7_500_000),
    },
    from: '2026-09-23T00:00:00.000Z',
    until: null,
    // Re-read once the standard price is the only one Google shows: after this, nothing is priced on it.
    verifiedUntil: '2027-02-01T00:00:00.000Z',
  },
]);

/**
 * What Google's pricing footnote says it may return later, kept apart from the
 * gross estimate. It is an expectation, never a confirmed credit: whether it
 * applies to a given account, and whether it stacks with a Free Trial or
 * welcome credit, is known only from the billing account's credits report.
 * Nothing in Nectovia subtracts it from a hold, a settlement or a customer debit.
 */
export const VERTEX_EXPECTED_PROMOTION = Object.freeze({
  status: 'expected-unconfirmed' as const,
  kind: 'credit-back-on-net-spend' as const,
  percent: 50,
  appliesThrough: '2026-12-31',
  stacksWithFreeTrial: 'unknown' as const,
  source:
    'https://cloud.google.com/vertex-ai/generative-ai/pricing, Gemini 3.8 Flash footnote, read 2026-09-23: "Promotional pricing provided through 50% credits back on net spend on select models within a given period." Net spend is after other credits, so a call paid by Free Trial credit is expected to earn nothing back.',
});

/** The expected credit-back on a gross estimate, for display only; never a confirmed credit. */
export function vertexExpectedPromotionMicroUsd(grossMicroUsd: number, at: Date): number {
  if (at.getTime() >= Date.parse('2027-01-01T08:00:00.000Z')) return 0;
  return Math.floor((grossMicroUsd * VERTEX_EXPECTED_PROMOTION.percent) / 100);
}

/**
 * The owner route's five cost figures from the local ledger. The owner's own
 * Google project pays, so no Nectovia credit is debited; confirmed credits and
 * the invoice exist only in the Cloud Billing account and are pointed to, never
 * guessed.
 */
export function vertexAccounting(projectId: string, summary: ExposureSummary, at: Date): VertexAccountingView {
  const billing = `Google Cloud console, Billing, the account linked to project ${projectId}`;
  return {
    payer: { kind: 'owner-google-cloud-project', projectId },
    grossEstimateMicroUsd: summary.settledMicroUsd,
    unresolvedEstimateMicroUsd: summary.pendingMicroUsd + summary.uncertainMicroUsd,
    expectedPromotion: {
      status: VERTEX_EXPECTED_PROMOTION.status,
      percent: VERTEX_EXPECTED_PROMOTION.percent,
      appliesThrough: VERTEX_EXPECTED_PROMOTION.appliesThrough,
      stacksWithFreeTrial: VERTEX_EXPECTED_PROMOTION.stacksWithFreeTrial,
      expectedMicroUsd: vertexExpectedPromotionMicroUsd(summary.settledMicroUsd, at),
      source: VERTEX_EXPECTED_PROMOTION.source,
    },
    confirmedCredits: { known: false, where: `${billing}, Reports, with credits shown` },
    customerDebitMicroUsd: 0,
    invoice: { known: false, where: `${billing}, Documents` },
  };
}

/**
 * The card in force at `at`. A date no card covers, or one past its evidence,
 * refuses: an expired introductory price is never carried forward, and a price
 * nobody has re-read is never assumed.
 */
export function vertexRateCard(at: Date): ModelRateCard {
  const time = at.getTime();
  const entry = VERTEX_RATE_CARDS.find(
    (candidate) =>
      Date.parse(candidate.from) <= time && (candidate.until === null || time < Date.parse(candidate.until)),
  );
  if (!entry)
    throw new ModelApiError(
      'vertex_rate_card_missing',
      'No Gemini 3.8 Flash price is recorded for this date. Nothing was sent.',
      false,
    );
  if (time >= Date.parse(entry.verifiedUntil))
    throw new ModelApiError(
      'vertex_rate_card_stale',
      `The recorded Gemini 3.8 Flash price (${entry.card.version}) needs re-checking against Google’s pricing page before more calls are priced. Nothing was sent.`,
      false,
    );
  return entry.card;
}

/** Refuses a card that is not the one in force now: a hold is priced under current terms or not at all. */
export function requireCurrentVertexCard(card: ModelRateCard, at: Date) {
  const current = vertexRateCard(at);
  if (card.version !== current.version)
    throw new ModelApiError(
      'vertex_rate_card_expired',
      `The price this call was prepared with (${card.version}) is no longer in force. Nothing was sent.`,
      false,
    );
}

// --- the credential: Application Default Credentials from one exact file -----------

export type AdcSource = 'gcloud-user' | 'service-account' | 'impersonated-service-account' | 'external-account';

/** What is known about the ADC file without reading any secret out of it. */
export interface AdcIdentity {
  /** Where the file is. Named by GOOGLE_APPLICATION_CREDENTIALS, or gcloud's well-known path. */
  path: string;
  namedBy: 'GOOGLE_APPLICATION_CREDENTIALS' | 'gcloud-default';
  source: AdcSource;
  /** sha256 of the identity fields only (type, client id, account email, quota project, impersonation target). */
  fingerprint: string;
  /** The quota project gcloud recorded in the file, when there is one. Evidence; the request names its own. */
  quotaProject: string | null;
  /** The service account's email for a key or impersonation, never a user's refresh token. */
  principal: string | null;
}

export function adcPath(env: NodeJS.ProcessEnv = process.env): { path: string; namedBy: AdcIdentity['namedBy'] } {
  const named = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (named) return { path: path.resolve(named), namedBy: 'GOOGLE_APPLICATION_CREDENTIALS' };
  const base =
    process.platform === 'win32'
      ? path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud')
      : path.join(env.CLOUDSDK_CONFIG ?? path.join(os.homedir(), '.config', 'gcloud'));
  return { path: path.join(base, 'application_default_credentials.json'), namedBy: 'gcloud-default' };
}

const sourceOf = (type: unknown): AdcSource | null =>
  type === 'authorized_user'
    ? 'gcloud-user'
    : type === 'service_account'
      ? 'service-account'
      : type === 'impersonated_service_account'
        ? 'impersonated-service-account'
        : type === 'external_account'
          ? 'external-account'
          : null;

/**
 * Reads the ADC file's identity. Returns null when there is no readable file:
 * a missing credential refuses before any network I/O, token exchange included.
 * The secret fields (refresh token, private key) are read by nothing here.
 */
export async function readAdcIdentity(env: NodeJS.ProcessEnv = process.env): Promise<AdcIdentity | null> {
  const where = adcPath(env);
  let raw: string;
  try {
    raw = await fs.readFile(where.path, 'utf8');
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const source = sourceOf(parsed.type);
  if (!source) return null;
  const impersonation = str(parsed.service_account_impersonation_url);
  const principal =
    str(parsed.client_email) ??
    (impersonation ? (/serviceAccounts\/([^:/]+):generateAccessToken/.exec(impersonation)?.[1] ?? null) : null);
  const quotaProject = str(parsed.quota_project_id);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        type: parsed.type,
        client_id: str(parsed.client_id),
        principal,
        quota_project_id: quotaProject,
        impersonation,
        audience: str(parsed.audience),
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return { path: where.path, namedBy: where.namedBy, source, fingerprint, quotaProject, principal };
}

/** A short-lived access token and when it stops working. Held in memory for one call only. */
export interface AccessToken {
  token: string;
  expiresAt: string | null;
}

/**
 * Mints a token from exactly the ADC file the connection was verified with.
 * This is the only network I/O before the model call (Google's token endpoint),
 * and it happens only after the file matched the saved fingerprint.
 */
export async function mintVertexToken(
  connection: Pick<VertexConnection, 'projectId' | 'credential'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccessToken> {
  const identity = await readAdcIdentity(env);
  if (!identity)
    throw new ModelApiError(
      'vertex_credential_missing',
      'No Google Application Default Credentials were found. Run `gcloud auth application-default login` and verify the connection in AI setup. Nothing was sent.',
      false,
    );
  if (identity.fingerprint !== connection.credential.fingerprint)
    throw new ModelApiError(
      'vertex_credential_changed',
      'The Google credential on this computer is not the one this connection was verified with. Verify it again in AI setup. Nothing was sent.',
      false,
    );
  const auth = new GoogleAuth({
    keyFilename: identity.path,
    projectId: connection.projectId,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  let result: { token?: string | null; res?: { data?: { expiry_date?: unknown } } | null };
  try {
    const client = await auth.getClient();
    result = (await client.getAccessToken()) as typeof result;
  } catch {
    // The library's message can quote the file; only the fact is reported.
    throw new ModelApiError(
      'vertex_credential_refused',
      'Google did not issue an access token for the saved credential. Sign in again with `gcloud auth application-default login`. Nothing was sent.',
      false,
    );
  }
  if (!result.token)
    throw new ModelApiError('vertex_credential_refused', 'Google issued no access token. Nothing was sent.', false);
  const expiry = result.res?.data?.expiry_date;
  return { token: result.token, expiresAt: typeof expiry === 'number' ? new Date(expiry).toISOString() : null };
}

// --- the connection record ------------------------------------------------------------

const iso = z.string().datetime({ offset: true });
export const vertexConnectionSchema = z
  .strictObject({
    v: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    projectId: z.string().regex(VERTEX_PROJECT),
    location: z.literal(VERTEX_LOCATION),
    baseUrl: z.string(),
    model: z.literal(VERTEX_GEMINI_MODEL),
    /** Google's global endpoint may process a request in any Google region. */
    processing: z.literal('google-global'),
    /** Who the provider bills: always the project in the URL, never the credential's own project. */
    payer: z.strictObject({ kind: z.literal('google-cloud-project'), projectId: z.string().regex(VERTEX_PROJECT) }),
    credential: z.strictObject({
      kind: z.literal('google-adc'),
      source: z.enum(['gcloud-user', 'service-account', 'impersonated-service-account', 'external-account']),
      namedBy: z.enum(['GOOGLE_APPLICATION_CREDENTIALS', 'gcloud-default']),
      fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
      principal: z.string().max(320).nullable(),
      quotaProject: z.string().max(64).nullable(),
      savedAt: iso,
      /** ADC is renewed by Google's token endpoint; the record itself does not expire. */
      expiresAt: z.null(),
    }),
    /** Bumped by every change: part of the account route, so it fences saved context and results. */
    revision: z.number().int().min(1),
    createdAt: iso,
    updatedAt: iso,
  })
  .superRefine((value, context) => {
    if (value.baseUrl !== vertexBaseUrl(value.projectId))
      context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'The endpoint must be the project’s own global Vertex endpoint.' });
    if (value.payer.projectId !== value.projectId)
      context.addIssue({ code: 'custom', path: ['payer'], message: 'The payer is the project the request names.' });
  });
export type VertexConnection = z.infer<typeof vertexConnectionSchema>;

export const vertexAccountRoute = (connection: Pick<VertexConnection, 'id' | 'revision' | 'projectId'>) =>
  `${GOOGLE_VERTEX_ROUTE}:${connection.id}:${connection.projectId}@r${connection.revision}`;

export class VertexConnections extends ConnectionFile<typeof vertexConnectionSchema> {
  constructor(dataDir: string) {
    super(dataDir, GOOGLE_VERTEX_ROUTE, vertexConnectionSchema, 'Google Vertex AI');
  }
}

// --- classification of Vertex's own bytes -------------------------------------------

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageMetadataSchema = z.object({
  promptTokenCount: count,
  candidatesTokenCount: count.nullish(),
  thoughtsTokenCount: count.nullish(),
  cachedContentTokenCount: count.nullish(),
  toolUsePromptTokenCount: count.nullish(),
  totalTokenCount: count.nullish(),
});

/**
 * Vertex usage in the ledger's structure. `promptTokenCount` already includes
 * the cached tokens; thinking is reported apart from the answer and billed as
 * output. A total that does not add up is refused: repairing it would be a
 * guess about money.
 */
export function vertexUsage(raw: unknown): ProviderUsage | null {
  const parsed = usageMetadataSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  const input = value.promptTokenCount + (value.toolUsePromptTokenCount ?? 0);
  const reasoning = value.thoughtsTokenCount ?? 0;
  const output = (value.candidatesTokenCount ?? 0) + reasoning;
  if (value.totalTokenCount != null && value.totalTokenCount !== input + output) return null;
  return consistentUsage({
    inputTokens: input,
    cacheReadTokens: value.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens: reasoning,
  });
}

const REFUSED_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
  'MODEL_ARMOR',
]);
const TOOL_FAILURE_FINISH = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS']);
const PART_KEYS_ALLOWED = new Set(['text', 'thought', 'thoughtSignature', 'functionCall']);

/** The id a function call without its own id is known by: the same sequence the SDK is given. */
export const vertexCallId = (base: string, index: number) => `${base}-${index}`;

/**
 * Reads a Vertex stream (or its JSON error body) as data. Nothing in it can
 * widen what the route does. A server-side tool, code execution, an inline
 * file, a second candidate or an unknown part is unexpected output.
 */
export function classifyVertex(envelope: StreamEnvelope, callIdBase: string): { readable: boolean; classified: ClassifiedEnvelope | null } {
  if (!envelope.readable) return { readable: false, classified: null };
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
  };
  const events: unknown[] = envelope.events ?? (Array.isArray(envelope.body) ? envelope.body : [envelope.body]);
  let finish: string | null = null;
  let blocked: string | null = null;
  let unnamed = 0;
  for (const event of events) {
    const value = event && typeof event === 'object' && !Array.isArray(event) ? (event as Record<string, unknown>) : null;
    if (!value) {
      result.unexpectedItems.push('event:not-an-object');
      continue;
    }
    const error = value.error as { code?: unknown; message?: unknown; status?: unknown } | undefined;
    if (error && typeof error === 'object') {
      result.providerError ??= {
        code: str(error.status) ?? (typeof error.code === 'number' ? String(error.code) : str(error.code)),
        message: bounded(str(error.message) ?? 'Unknown provider error.'),
      };
      continue;
    }
    result.responseId = str(value.responseId) ?? result.responseId;
    result.reportedModel = str(value.modelVersion) ?? result.reportedModel;
    if (value.usageMetadata !== undefined) {
      result.usage = vertexUsage(value.usageMetadata);
      result.rawUsage = structuredClone(value.usageMetadata);
    }
    const feedback = value.promptFeedback as { blockReason?: unknown } | undefined;
    if (feedback && str(feedback.blockReason)) blocked = str(feedback.blockReason);
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    if (candidates.length > 1) result.unexpectedItems.push('candidates:multiple');
    const candidate =
      candidates[0] && typeof candidates[0] === 'object' ? (candidates[0] as Record<string, unknown>) : null;
    if (!candidate) continue;
    if (typeof candidate.index === 'number' && candidate.index !== 0) result.unexpectedItems.push('candidate:index');
    finish = str(candidate.finishReason) ?? finish;
    const content = candidate.content as { parts?: unknown; role?: unknown } | undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      const piece = part && typeof part === 'object' && !Array.isArray(part) ? (part as Record<string, unknown>) : {};
      const unknown = Object.keys(piece).filter((key) => !PART_KEYS_ALLOWED.has(key));
      if (unknown.length) {
        result.unexpectedItems.push(`part:${unknown.join(',')}`);
        continue;
      }
      if (piece.functionCall !== undefined) {
        const call = piece.functionCall as Record<string, unknown> | null;
        if (!call || typeof call !== 'object' || call.partialArgs !== undefined || call.willContinue !== undefined) {
          result.unexpectedItems.push('functionCall:streamed-arguments');
          continue;
        }
        const args = call.args ?? {};
        result.functionCalls.push({
          callId: str(call.id) || vertexCallId(callIdBase, unnamed++),
          name: str(call.name) ?? '',
          arguments: args && typeof args === 'object' && !Array.isArray(args) ? JSON.stringify(args) : '',
        });
      } else if (typeof piece.text === 'string') {
        // Thinking is billed and never shown; only the answer is text.
        if (piece.thought !== true) result.text += piece.text;
      } else if (piece.thoughtSignature === undefined) result.unexpectedItems.push('part:empty');
    }
  }
  if (result.providerError) return { readable: true, classified: result };
  if (blocked && !finish) {
    result.status = 'incomplete';
    result.incompleteReason = 'content_filter';
  } else if (finish === 'STOP') result.status = 'completed';
  else if (finish === 'MAX_TOKENS') {
    result.status = 'incomplete';
    result.incompleteReason = 'max_output_tokens';
  } else if (finish && REFUSED_FINISH.has(finish)) {
    result.status = 'incomplete';
    result.incompleteReason = 'content_filter';
  } else if (finish && TOOL_FAILURE_FINISH.has(finish)) {
    result.status = 'completed';
    result.unexpectedItems.push(`finish:${finish}`);
  } else result.status = finish ? `finish:${finish}` : null;
  return { readable: true, classified: result };
}

/** Whatever usage a failed call reported, so it is settled rather than guessed. */
export function vertexEnvelopeUsage(envelope: StreamEnvelope): ProviderUsage | null {
  if (!envelope.readable) return null;
  const events: unknown[] = envelope.events ?? (Array.isArray(envelope.body) ? envelope.body : [envelope.body]);
  let usage: ProviderUsage | null = null;
  for (const event of events) {
    const value = event && typeof event === 'object' ? (event as Record<string, unknown>) : null;
    if (value && value.usageMetadata !== undefined) usage = vertexUsage(value.usageMetadata);
  }
  return usage;
}

// --- the call ---------------------------------------------------------------------------

const VERTEX_REQUEST_ID_HEADERS = ['x-goog-request-id', 'x-request-id', 'x-cloud-trace-context'] as const;

/**
 * Only the minted bearer token reaches Vertex, after the destination checks, and
 * the project it names is the one billed. Headers that would pick a priced tier
 * (Priority, Flex) or another credential are removed.
 */
function attachVertexToken(projectId: string) {
  return (headers: Headers, secret: string) => {
    for (const name of [
      'authorization',
      'x-goog-api-key',
      'x-goog-user-project',
      'x-vertex-ai-llm-shared-request-type',
      'x-vertex-ai-llm-request-type',
    ])
      headers.delete(name);
    headers.set('authorization', `Bearer ${secret}`);
    headers.set('x-goog-user-project', projectId);
  };
}

/**
 * The serialized request carries the conversation and function declarations
 * only: no server-side tool (search, code execution, URL context, retrieval),
 * no explicit cache, no visible thinking, one candidate.
 */
export function inspectVertexBody(text: string) {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  const refuse = (why: string) => {
    throw new ModelApiError('vertex_request_refused', `The request ${why}. Nothing was sent.`, false);
  };
  if (!body || !Array.isArray(body.contents)) return refuse('was not a Vertex generateContent body');
  if (body.cachedContent !== undefined) return refuse('named an explicit cache');
  const tools = body.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return refuse('carried tools in an unknown shape');
    for (const tool of tools)
      if (!tool || typeof tool !== 'object' || Object.keys(tool).some((key) => key !== 'functionDeclarations'))
        return refuse('offered a tool Google would run itself');
  }
  const config = (body.generationConfig ?? {}) as Record<string, unknown>;
  const thinking = (config.thinkingConfig ?? {}) as Record<string, unknown>;
  if (thinking.includeThoughts === true) return refuse('asked for visible thinking');
  if (config.candidateCount !== undefined && config.candidateCount !== 1) return refuse('asked for several answers');
}

/** Gemini 3's thinking level for each Diomedes effort. */
const THINKING: Record<'low' | 'medium' | 'high', 'low' | 'medium' | 'high'> = { low: 'low', medium: 'medium', high: 'high' };

/**
 * A client that hands the SDK a placeholder instead of loading any credential.
 * The SDK's own Google auth would otherwise read GOOGLE_APPLICATION_CREDENTIALS,
 * the gcloud file or the metadata server on every request.
 */
const placeholderAuthClient = {
  getAccessToken: async () => ({ token: CREDENTIAL_PLACEHOLDER }),
  getRequestHeaders: async () => new Headers(),
};

export function vertexBinding(
  connection: VertexConnection,
  effort: 'low' | 'medium' | 'high',
  callIdBase: string,
): RouteBinding {
  let sequence = 0;
  return {
    route: GOOGLE_VERTEX_ROUTE,
    prefix: 'vertex',
    label: 'Google Vertex AI',
    connectionId: connection.id,
    modelId: connection.model,
    expiresAt: null,
    model: (fetch) =>
      createVertex({
        project: connection.projectId,
        location: VERTEX_LOCATION,
        baseURL: connection.baseUrl,
        // An explicit empty key keeps the SDK out of Express Mode even when GOOGLE_VERTEX_API_KEY is set.
        apiKey: '',
        googleAuthOptions: { authClient: placeholderAuthClient as never },
        generateId: () => vertexCallId(callIdBase, sequence++),
        fetch,
      }).languageModel(connection.model),
    guard: {
      expectedUrl: vertexStreamUrl(connection.projectId),
      expectedQuery: '?alt=sse',
      attach: attachVertexToken(connection.projectId),
      inspectBody: inspectVertexBody,
      requestIdHeaders: VERTEX_REQUEST_ID_HEADERS,
    },
    providerOptions: {
      vertex: {
        thinkingConfig: { thinkingLevel: THINKING[effort], includeThoughts: false },
      },
    },
    classify: (envelope) => classifyVertex(envelope, callIdBase),
    usage: vertexEnvelopeUsage,
    served: (classified) =>
      classified.reportedModel !== null &&
      // The model itself or a numbered version of it: never a sibling such as `-lite`.
      !/^gemini-3\.8-flash(-\d{3})?$/.test(classified.reportedModel)
        ? {
            code: 'vertex_model_mismatch',
            message: `Vertex reported ${bounded(classified.reportedModel, 80)} instead of ${connection.model}. The answer was not used.`,
          }
        : null,
    // Google charges only for requests that return HTTP 200: a readable error answer is released.
    releasableStatuses: new Set([400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504]),
  };
}

/** One Vertex exchange: reserve, stream once, classify, settle. Never retried, never rerouted. */
export async function respondVertex(
  input: {
    connection: VertexConnection;
    /** A short-lived access token minted for this call. */
    secret: string;
    card: ModelRateCard;
    exposure: CallExposure;
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
  const connection = vertexConnectionSchema.parse(input.connection);
  requireCurrentVertexCard(input.card, (input.now ?? (() => new Date()))());
  const { connection: _connection, effort, ...rest } = input;
  const callIdBase = `vtx-${input.attempt.requestDigest.slice(0, 12)}-${input.attempt.attempt}`;
  return respondStream({ ...rest, binding: vertexBinding(connection, effort, callIdBase) });
}

/** True when this process could read an ADC file right now. Detection grants nothing. */
export function adcPresent(env: NodeJS.ProcessEnv = process.env) {
  try {
    return fsSync.statSync(adcPath(env).path).isFile();
  } catch {
    return false;
  }
}
