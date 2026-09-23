/**
 * The direct Azure OpenAI route: the company's own Azure OpenAI resource,
 * reached through its v1 Responses endpoint with the resource's API key.
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
import { digest } from '../harness/policy.js';
import type { ExposureAttempt, ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { ConnectionFile } from './connection-file.js';
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
 * The v1 API: `https://<resource>.openai.azure.com/openai/v1/responses`, with no
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

export const azureEndpoint = (resourceName: string) => `https://${resourceName}.openai.azure.com/openai/v1`;

// --- the connection record ------------------------------------------------------

const iso = z.string().datetime({ offset: true });
export const azureDeploymentSchema = z.strictObject({
  /** What Settings and a run record call it. */
  model: z.string().regex(AZURE_LOGICAL_MODEL),
  /** What Azure is asked for. */
  deployment: z.string().regex(AZURE_DEPLOYMENT),
  /** Whether the deployed model is a reasoning model: decides the system role and reasoning options. */
  reasoning: z.boolean(),
  rates: declaredRatesSchema,
});
export type AzureDeployment = z.infer<typeof azureDeploymentSchema>;

export const azureConnectionSchema = z
  .strictObject({
    v: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    resourceName: z.string().regex(AZURE_RESOURCE),
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
    if (value.baseUrl !== azureEndpoint(value.resourceName))
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
  effort: 'low' | 'medium' | 'high',
): RouteBinding {
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
    providerOptions: {
      azure: entry.reasoning
        ? {
            // A deployment name says nothing about the model behind it, so the SDK cannot infer
            // reasoning support from it; the owner declared it at setup.
            forceReasoning: true,
            systemMessageMode: 'developer',
            include: ['reasoning.encrypted_content'],
            reasoningEffort: effort,
            reasoningSummary: null,
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
    effort: 'low' | 'medium' | 'high';
    limits: RespondLimits;
    signal: AbortSignal;
    transport?: typeof globalThis.fetch;
    now?: () => Date;
  } & StreamSinks,
): Promise<RespondResult> {
  const connection = azureConnectionSchema.parse(input.connection);
  const entry = azureDeploymentFor(connection, input.model);
  const { connection: _connection, model: _model, effort, ...rest } = input;
  return respondStream({ ...rest, binding: azureBinding(connection, entry, effort) });
}
