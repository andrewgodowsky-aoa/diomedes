/**
 * The owner's cache setting on the server (DIO-215): the scoped cache key, the request one setting
 * sends on one call, and the capability record AI setup and the run record read.
 *
 * The key is made here and only here: `dio1-` and the first 40 hex digits of sha-256 over the
 * canonical JSON of its scope (tenant, route, connection, connection revision and model). No two
 * scopes share a key, and none of them can be read back from it, so the scope never leaves this
 * process in clear. A key that is not a derived key is a refusal before anything is held or sent.
 *
 * A capability record is the declared facts for one route and model (`declared-capabilities.ts`)
 * overlaid by the newest route check receipt, and only while that receipt qualifies the exact
 * identity now (`capabilityRecord`).
 */
import { declaredCapabilities } from '../../shared/declared-capabilities.js';
import {
  cacheRequest,
  capabilityRecord,
  type CacheKeyScope,
  type CachePolicy,
  type CacheRequest,
  type RouteCapability,
} from '../../shared/route-capabilities.js';
import type { QualificationIdentity, RouteQualificationReceipt } from '../../shared/route-qualification.js';
import { digest } from '../harness/policy.js';
import { AWS_BEDROCK_ROUTE, awsQualificationIdentity, type AwsConnection } from './aws-bedrock.js';
import { AZURE_OPENAI_ROUTE, azureQualificationIdentity, type AzureConnection } from './azure-openai.js';
import { ModelApiError } from './model-api-core.js';
import type { RouteQualifications } from './route-qualification-store.js';

/** The routes with an owner's cache setting in this build: the two that have route checks. */
export const CACHE_POLICY_ROUTES = [AWS_BEDROCK_ROUTE, AZURE_OPENAI_ROUTE] as const;
export type CachePolicyRoute = (typeof CACHE_POLICY_ROUTES)[number];
export const isCachePolicyRoute = (route: string): route is CachePolicyRoute =>
  (CACHE_POLICY_ROUTES as readonly string[]).includes(route);

/** The tenant a computer with no signed-in principal keys its caches under. */
export const LOCAL_CACHE_TENANT = 'local';

const scopeRefusal = (prefix: string) =>
  new ModelApiError(`${prefix}_cache_refused`, 'The cache key for this call could not be made.', false);

/** `dio1-` and the first 40 hex digits of sha-256 over the scope's canonical JSON. */
export function cacheKey(scope: CacheKeyScope): string {
  const { tenantId, route, connectionId, connectionRevision, model } = scope;
  return `dio1-${digest({ tenantId, route, connectionId, connectionRevision, model }).slice(0, 40)}`;
}

/**
 * The request one setting sends with a given key. A key that is not a derived key makes no
 * request, and that is a refusal: nothing is held or sent.
 */
export function cacheRequestWithKey(prefix: string, policy: CachePolicy, key: string): CacheRequest {
  const request = policy === 'explicit-prefix' ? cacheRequest({ policy, key }) : cacheRequest({ policy });
  if (!request) throw scopeRefusal(prefix);
  return request;
}

/**
 * The request the owner's setting sends on one call. Only an explicit prefix carries a key, made
 * from the call's whole scope; a scope with an empty part is refused rather than shared.
 */
export function routeCacheRequest(prefix: string, policy: CachePolicy, scope: CacheKeyScope): CacheRequest {
  if (policy !== 'explicit-prefix') return cacheRequestWithKey(prefix, policy, '');
  if (
    !scope.tenantId ||
    !scope.route ||
    !scope.connectionId ||
    !scope.model ||
    !Number.isSafeInteger(scope.connectionRevision) ||
    scope.connectionRevision < 1
  )
    throw scopeRefusal(prefix);
  return cacheRequestWithKey(prefix, policy, cacheKey(scope));
}

/** One identity's record from its declared facts and the newest receipt for it. */
export function routeCapability(input: {
  identity: QualificationIdentity;
  endpoint: string;
  receipt: RouteQualificationReceipt | null;
  now: number;
}): RouteCapability {
  return capabilityRecord({
    identity: input.identity,
    endpoint: input.endpoint,
    declared: declaredCapabilities(input.identity.route, input.identity.model),
    receipt: input.receipt,
    now: input.now,
  });
}

/** The AWS connection's model, judged by its newest receipt. No store reads as no receipt. */
export async function awsCapability(
  receipts: Pick<RouteQualifications, 'latest'> | undefined,
  connection: AwsConnection,
  now: number,
): Promise<RouteCapability> {
  const receipt = receipts
    ? await receipts.latest(AWS_BEDROCK_ROUTE, connection.id, { model: connection.modelId, deployment: null })
    : null;
  return routeCapability({ identity: awsQualificationIdentity(connection), endpoint: connection.baseUrl, receipt, now });
}

/** One Azure deployment's model, judged by its newest receipt. No store reads as no receipt. */
export async function azureCapability(
  receipts: Pick<RouteQualifications, 'latest'> | undefined,
  connection: AzureConnection,
  model: string,
  now: number,
): Promise<RouteCapability> {
  const identity = azureQualificationIdentity(connection, model);
  const receipt = receipts
    ? await receipts.latest(AZURE_OPENAI_ROUTE, connection.id, { model: identity.model, deployment: identity.deployment })
    : null;
  return routeCapability({ identity, endpoint: connection.baseUrl, receipt, now });
}
