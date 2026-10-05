/**
 * The owner's cache setting and the capability records (DIO-215), mounted beside each route's setup:
 *
 *   GET /api/ai/model-api/aws-bedrock/cache-policy                 the setting, the model's record, the turn note
 *   PUT /api/ai/model-api/aws-bedrock/cache-policy                 { policy }
 *   GET /api/ai/model-api/aws-bedrock/capabilities                 the connection's model's record
 *   GET /api/ai/model-api/azure-openai/cache-policy                the same, one record per deployment
 *   PUT /api/ai/model-api/azure-openai/cache-policy                { policy }
 *   GET /api/ai/model-api/azure-openai/capabilities?model=…        one deployment's record
 *
 * The setting lives in Settings services under `cachePolicyKey(route)`, and only this route writes
 * it: a whole settings save keeps whatever is stored. It belongs to the route, so it can be chosen
 * before a connection exists and it survives a reconnect. No response carries a cache key or the
 * scope a key is made from.
 */
import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { RouteCacheModelView, RouteCachePolicyView, RouteCapabilityView } from '../../shared/model-api.js';
import {
  CACHE_POLICIES,
  cacheAccount,
  cachePolicyKey,
  readCachePolicy,
  type CachePolicy,
} from '../../shared/route-capabilities.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import { AWS_BEDROCK_ROUTE, AwsConnectionRetired, type AwsConnection } from './aws-bedrock.js';
import { AZURE_OPENAI_ROUTE, type AzureConnection } from './azure-openai.js';
import { awsCapability, azureCapability, type CachePolicyRoute } from './route-cache.js';
import type { EngineService, ModelApiServices } from './service.js';

const policyBody = z.strictObject({
  policy: z.enum(CACHE_POLICIES, { message: 'Choose the provider’s default, off or an explicit prefix.' }),
});
const azureModel = z.string().min(1, 'Name the Azure model to read.').max(64);

/** What a conversation turn marks under an explicit prefix: its stable start. */
const previewOf = (policy: CachePolicy, capability: RouteCacheModelView['capability']) =>
  cacheAccount(policy, capability, policy === 'explicit-prefix' ? 'stable-prefix' : null);

export function mountRouteCacheRoutes(
  app: Express,
  deps: { store: Store; engines: EngineService },
  route: (action: (req: Request) => Promise<unknown>) => RequestHandler,
) {
  const { store } = deps;
  const api = (): ModelApiServices => {
    if (!deps.engines.modelApi) throw new ApiError(503, 'The model-API runtime is not available.');
    return deps.engines.modelApi;
  };
  /** The saved AWS connection; one an earlier version saved for a retired model reads as none. */
  const awsConnection = async (services: ModelApiServices): Promise<AwsConnection | null> => {
    try {
      return await services.connections.read();
    } catch (error) {
      if (error instanceof AwsConnectionRetired) return null;
      throw error;
    }
  };
  const azureConnection = async (services: ModelApiServices): Promise<AzureConnection | null> => {
    if (!services.azure) throw new ApiError(503, 'The Azure OpenAI route is not available in this process.');
    return services.azure.connections.read();
  };

  const models = async (target: CachePolicyRoute, policy: CachePolicy): Promise<RouteCacheModelView[]> => {
    const services = api();
    const now = Date.now();
    if (target === AWS_BEDROCK_ROUTE) {
      const connection = await awsConnection(services);
      if (!connection) return [];
      const capability = await awsCapability(services.qualifications, connection, now);
      return [{ model: connection.modelId, deployment: null, capability, preview: previewOf(policy, capability) }];
    }
    const connection = await azureConnection(services);
    if (!connection) return [];
    return Promise.all(
      connection.deployments.map(async (entry) => {
        const capability = await azureCapability(services.qualifications, connection, entry.model, now);
        return { model: entry.model, deployment: entry.deployment, capability, preview: previewOf(policy, capability) };
      }),
    );
  };

  const view = async (target: CachePolicyRoute): Promise<RouteCachePolicyView> => {
    const policy = readCachePolicy(store.settings.services, target);
    return {
      route: target,
      policy,
      chosen: store.settings.services?.[cachePolicyKey(target)] === policy,
      models: await models(target, policy),
    };
  };

  for (const target of [AWS_BEDROCK_ROUTE, AZURE_OPENAI_ROUTE] as const) {
    const base = `/api/ai/model-api/${target}`;
    app.get(`${base}/cache-policy`, route(() => view(target)));
    app.put(
      `${base}/cache-policy`,
      route((req) =>
        store.locked(async () => {
          const body = policyBody.parse(req.body);
          await store.saveSettings({
            ...store.settings,
            services: { ...store.settings.services, [cachePolicyKey(target)]: body.policy },
          });
          return view(target);
        }),
      ),
    );
  }

  app.get(
    `/api/ai/model-api/${AWS_BEDROCK_ROUTE}/capabilities`,
    route(async (): Promise<RouteCapabilityView> => {
      const services = api();
      const connection = await awsConnection(services);
      return {
        route: AWS_BEDROCK_ROUTE,
        model: connection?.modelId ?? null,
        deployment: null,
        capability: connection ? await awsCapability(services.qualifications, connection, Date.now()) : null,
      };
    }),
  );
  app.get(
    `/api/ai/model-api/${AZURE_OPENAI_ROUTE}/capabilities`,
    route(async (req): Promise<RouteCapabilityView> => {
      const model = azureModel.parse(typeof req.query.model === 'string' ? req.query.model : '');
      const services = api();
      const connection = await azureConnection(services);
      const capability = connection ? await azureCapability(services.qualifications, connection, model, Date.now()) : null;
      return {
        route: AZURE_OPENAI_ROUTE,
        model,
        deployment: capability ? (connection!.deployments.find((entry) => entry.model === model)?.deployment ?? null) : null,
        capability,
      };
    }),
  );
}
