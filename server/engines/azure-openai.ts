/**
 * The direct Azure OpenAI route: the company's own Azure AI Foundry or Azure
 * OpenAI resource, reached through its v1 Responses endpoint with the
 * resource's API key.
 *
 * Azure identity is a resource and a deployment, never a generic model slug.
 * The connection names one resource (the endpoint is built from its validated
 * name, never taken from a caller) and maps each logical model the owner
 * offers to the deployment that serves it. The request's `model` field is that
 * deployment's name, checked again in the serialized body before it leaves.
 *
 * Everything else is the shared model-API core: one streamed call, no retry,
 * no SDK tool executor, `store: false`, the credential attached only to the
 * exact endpoint, and a spend hold reserved before sending and settled from
 * the usage Azure reports. There is no fallback to another resource, another
 * deployment or another route: Azure terms and Azure billing are this
 * connection's alone.
 */
import { createAzure } from '@ai-sdk/azure';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ToolDescriptor } from '../../shared/harness.js';
import { cacheNamespace, type CacheRequest } from '../../shared/route-capabilities.js';
import type { QualificationIdentity } from '../../shared/route-qualification.js';
import { digest } from '../harness/policy.js';
import type { ExposureAttempt, ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { ConnectionFile } from './connection-file.js';
import type { QualificationTarget } from './route-qualification.js';
import {
  classifyEnvelope,
  CREDENTIAL_PLACEHOLDER,
  declaredRateCard,
  declaredRatesSchema,
  ModelApiError,
  respondStream,
  responsesBody,
  responsesUsage,
  type RespondLimits,
  type RespondResult,
  type RouteBinding,
  type StreamSinks,
} from './model-api-core.js';

export const AZURE_OPENAI_ROUTE = 'azure-openai' as const;
/** The exact dependency set this route was written and tested against. */
export const AZURE_OPENAI_SDK = 'ai@7.0.107+@ai-sdk/azure@4.0.75+@ai-sdk/openai@4.0.71';
export const AZURE_OPENAI_PROTOCOL = 'openai-responses';
/**
 * The v1 API: `https://<resource>.<host>/openai/v1/responses`, with no
 * `api-version` query. The legacy deployment-path form is a different URL and is
 * refused by the guarded transport.
 */
export const AZURE_API_VERSION = 'v1' as const;
export const AZURE_CONNECTION_ID = 'azure-openai-1';

/** An Azure custom subdomain: lowercase letters, digits and inner hyphens, 2 to 64 characters. */
export const AZURE_RESOURCE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
/** An Azure OpenAI deployment name. */
export const AZURE_DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
/** The logical model a person picks, e.g. `gpt-5.6-luna`. Never sent to Azure. */
export const AZURE_LOGICAL_MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The two hosts a resource answers the v1 API on. An Azure AI Foundry resource serves its
 * deployments at `services.ai.azure.com`; a classic Azure OpenAI resource at `openai.azure.com`.
 * The owner says which; the host is never taken from a caller as a URL.
 */
export const AZURE_HOSTS = { foundry: 'services.ai.azure.com', openai: 'openai.azure.com' } as const;
export type AzureHost = keyof typeof AZURE_HOSTS;
export const azureHostSchema = z.enum(['foundry', 'openai']);

export const azureEndpoint = (resourceName: string, host: AzureHost = 'openai') =>
  `https://${resourceName}.${AZURE_HOSTS[host]}/openai/v1`;

// --- the connection record ------------------------------------------------------

const iso = z.string().datetime({ offset: true });
export const azureDeploymentSchema = z.strictObject({
  /** What Settings and a run record call it. */
  model: z.string().regex(AZURE_LOGICAL_MODEL),
  /** What Azure is asked for. */
  deployment: z.string().regex(AZURE_DEPLOYMENT),
  /** Whether the deployed model is a reasoning model: decides the system role and reasoning options. */
  reasoning: z.boolean(),
  /**
   * Whether this reasoning deployment accepts the extra-high level. The owner declares it, as with
   * `reasoning`; absent, the deployment is offered low to high and xhigh is never sent.
   */
  xhigh: z.boolean().optional(),
  rates: declaredRatesSchema,
});
export type AzureDeployment = z.infer<typeof azureDeploymentSchema>;
/** The reasoning levels the Azure route sends. `xhigh` only to a deployment declared to take it. */
export type AzureEffort = 'low' | 'medium' | 'high' | 'xhigh';
/** The levels one deployment offers, in order. */
export const azureEfforts = (entry: Pick<AzureDeployment, 'reasoning' | 'xhigh'>): AzureEffort[] =>
  !entry.reasoning ? [] : entry.xhigh ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];

export const azureConnectionSchema = z
  .strictObject({
    v: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    resourceName: z.string().regex(AZURE_RESOURCE),
    /** Absent on records saved before Foundry support: those are classic Azure OpenAI. */
    host: azureHostSchema.optional(),
    baseUrl: z.string(),
    apiVersion: z.literal(AZURE_API_VERSION),
    deployments: z.array(azureDeploymentSchema).min(1).max(16),
    credential: z.strictObject({
      kind: z.literal('azure-api-key'),
      fingerprint: z.string().regex(/^[a-f0-9]{12}$/),
      savedAt: iso,
      expiresAt: iso.nullable(),
    }),
    /** Bumped by every credential or scope change; part of the account route, so it fences results. */
    revision: z.number().int().min(1),
    createdAt: iso,
    updatedAt: iso,
  })
  .superRefine((value, context) => {
    if (value.baseUrl !== azureEndpoint(value.resourceName, value.host))
      context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'The endpoint must be the resource’s own v1 endpoint.' });
    const models = new Set(value.deployments.map((entry) => entry.model));
    const names = new Set(value.deployments.map((entry) => entry.deployment));
    if (models.size !== value.deployments.length || names.size !== value.deployments.length)
      context.addIssue({ code: 'custom', path: ['deployments'], message: 'Each model and each deployment appears once.' });
  });
export type AzureConnection = z.infer<typeof azureConnectionSchema>;

export const azureAccountRoute = (connection: Pick<AzureConnection, 'id' | 'revision'>) =>
  `${AZURE_OPENAI_ROUTE}:${connection.id}@r${connection.revision}`;

export class AzureConnections extends ConnectionFile<typeof azureConnectionSchema> {
  constructor(dataDir: string) {
    super(dataDir, AZURE_OPENAI_ROUTE, azureConnectionSchema, 'Azure OpenAI');
  }
}

/** The deployment that serves one logical model, or a refusal: there is no default deployment. */
export function azureDeploymentFor(connection: AzureConnection, model: string): AzureDeployment {
  const entry = connection.deployments.find((candidate) => candidate.model === model);
  if (!entry)
    throw new ModelApiError(
      'azure_unknown_model',
      `This Azure connection has no deployment for ${model}. Nothing was sent.`,
      false,
    );
  return entry;
}

/**
 * The owner-declared price of one logical model on this connection. The card's
 * version names the connection generation, so a changed price is a new card and
 * a hold is always settled under the card it was reserved with.
 */
export function azureRateCard(connection: AzureConnection, model: string): ModelRateCard {
  const entry = azureDeploymentFor(connection, model);
  return declaredRateCard(
    AZURE_OPENAI_ROUTE,
    entry.model,
    entry.rates,
    `${AZURE_OPENAI_ROUTE}:${entry.model}@r${connection.revision}:${digest(entry.rates).slice(0, 12)}`,
  );
}

// --- the call ---------------------------------------------------------------------

const AZURE_REQUEST_ID_HEADERS = ['apim-request-id', 'x-request-id', 'x-ms-request-id'] as const;

/** Only the saved resource key reaches Azure, in its own header, after the destination checks. */
function attachAzureKey(headers: Headers, secret: string) {
  headers.delete('authorization');
  headers.delete('api-key');
  headers.delete('openai-organization');
  headers.delete('openai-project');
  headers.set('api-key', secret);
}

/** The serialized request names the admitted deployment and nothing that would keep state at Azure. */
function inspectAzureBody(deployment: string) {
  return (text: string) => {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (
      !body ||
      body.model !== deployment ||
      body.store !== false ||
      body.stream !== true ||
      body.previous_response_id !== undefined ||
      body.conversation !== undefined ||
      body.background !== undefined
    )
      throw new ModelApiError(
        'azure_request_refused',
        'The request did not name the admitted Azure deployment with storage off. Nothing was sent.',
        false,
      );
  };
}

export function azureBinding(
  connection: AzureConnection,
  entry: AzureDeployment,
  requested: AzureEffort,
  /** Whether a thinking sink is listening: summaries are asked for only then. */
  summaries: boolean,
): RouteBinding {
  // A deployment not declared to take xhigh is asked for high, its own top level.
  const effort = requested === 'xhigh' && !entry.xhigh ? 'high' : requested;
  return {
    route: AZURE_OPENAI_ROUTE,
    prefix: 'azure',
    label: 'Azure',
    connectionId: connection.id,
    modelId: entry.model,
    expiresAt: connection.credential.expiresAt,
    model: (fetch) =>
      createAzure({
        // The resource's own v1 endpoint, built from its validated name. An explicit
        // placeholder key stops the SDK reading AZURE_API_KEY or AZURE_RESOURCE_NAME.
        baseURL: connection.baseUrl,
        apiKey: CREDENTIAL_PLACEHOLDER,
        apiVersion: AZURE_API_VERSION,
        fetch,
      }).responses(entry.deployment),
    guard: {
      expectedUrl: `${connection.baseUrl}/responses`,
      attach: attachAzureKey,
      inspectBody: inspectAzureBody(entry.deployment),
      requestIdHeaders: AZURE_REQUEST_ID_HEADERS,
    },
    // The Responses model reads cache options under `azure` for a provider named for Azure.
    cacheNamespace: cacheNamespace(AZURE_OPENAI_ROUTE, AZURE_OPENAI_PROTOCOL),
    providerOptions: {
      azure: entry.reasoning
        ? {
            // A deployment name says nothing about the model behind it, so the SDK cannot infer
            // reasoning support from it; the owner declared it at setup.
            forceReasoning: true,
            systemMessageMode: 'developer',
            include: ['reasoning.encrypted_content'],
            reasoningEffort: effort,
            reasoningSummary: summaries ? 'auto' : null,
            store: false,
            parallelToolCalls: false,
          }
        : { forceReasoning: false, systemMessageMode: 'system', store: false, parallelToolCalls: false },
    },
    classify: (envelope) => {
      const { readable, body } = responsesBody(envelope);
      return { readable, classified: readable ? classifyEnvelope(body) : null };
    },
    usage: responsesUsage,
  };
}

/**
 * What a route check receipt must match for one logical model on this connection: the deployment
 * that serves it and the price declared for it on this revision. Azure sends without a receipt; a
 * receipt here is evidence of what the deployment did.
 */
export function azureQualificationIdentity(connection: AzureConnection, model: string): QualificationIdentity {
  const entry = azureDeploymentFor(connection, model);
  return {
    route: AZURE_OPENAI_ROUTE,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    model: entry.model,
    protocol: AZURE_OPENAI_PROTOCOL,
    rateCard: azureRateCard(connection, model).version,
    deployment: entry.deployment,
  };
}

/**
 * The route checks' view of one deployment: its exact identity and its own binding, whose cache
 * namespace is `azure`, the one the SDK's Responses model reads for an Azure provider.
 */
export function azureQualificationTarget(
  connection: AzureConnection,
  model: string,
  effort: 'low' | 'medium' | 'high',
): QualificationTarget {
  const parsed = azureConnectionSchema.parse(connection);
  const entry = azureDeploymentFor(parsed, model);
  const card = azureRateCard(parsed, model);
  return {
    route: AZURE_OPENAI_ROUTE,
    connectionId: parsed.id,
    connectionRevision: parsed.revision,
    endpoint: parsed.baseUrl,
    deployment: entry.deployment,
    model: entry.model,
    protocol: AZURE_OPENAI_PROTOCOL,
    sdk: AZURE_OPENAI_SDK,
    rateCard: card.version,
    card,
    // The Responses request carries its output limit as `max_output_tokens`; the core sets it.
    binding: () => azureBinding(parsed, entry, effort, false),
  };
}

/** One Azure exchange: reserve, stream once, classify, settle. Never retried, never rerouted. */
export async function respondAzure(
  input: {
    connection: AzureConnection;
    /** The logical model; its deployment is looked up on the connection. */
    model: string;
    secret: string;
    card: ModelRateCard;
    exposure: SpendExposure;
    attempt: ExposureAttempt;
    instructions: string;
    messages: ModelMessage[];
    tools: readonly ToolDescriptor[];
    effort: AzureEffort;
    limits: RespondLimits;
    signal: AbortSignal;
    transport?: typeof globalThis.fetch;
    now?: () => Date;
    /** The stable start of `instructions`, or null where the path has none (`respondStream`). */
    stablePrefix?: string | null;
    /** The owner's cache setting for this call; absent sends the request as before. */
    cache?: CacheRequest | null;
  } & StreamSinks,
): Promise<RespondResult> {
  const connection = azureConnectionSchema.parse(input.connection);
  const entry = azureDeploymentFor(connection, input.model);
  const { connection: _connection, model: _model, effort, ...rest } = input;
  return respondStream({ ...rest, binding: azureBinding(connection, entry, effort, Boolean(rest.onReasoningDelta)) });
}
