/**
 * Setup for the Azure OpenAI and OpenRouter model-API routes, mirroring the AWS
 * Bedrock routes in `model-api-routes.ts`: connect, check, approve a spend
 * limit, reconcile an uncertain call, disconnect.
 *
 *   GET    /api/ai/model-api/<route>                         the connection, as identifiers and state
 *   PUT    /api/ai/model-api/<route>                         save the connection and key; switch the route on
 *   POST   /api/ai/model-api/<route>/test                    offline readiness: nothing is sent to the provider
 *   PUT    /api/ai/model-api/<route>/spend-limit             the owner's approved aggregate spend exposure
 *   POST   /api/ai/model-api/<route>/holds/:id/reconcile     record an uncertain call's actual cost
 *   POST   /api/ai/model-api/<route>/holds/:id/write-off     accept an uncertain call as spent at its ceiling
 *   DELETE /api/ai/model-api/<route>                         forget the key; switch the route off
 *
 * The key goes one way: into protected storage, under this route's own
 * connection id. No route reads it back and no response contains it. Spend
 * records are never deleted by disconnecting, reconnecting or reinstalling.
 * Each route has its own connection, key, ledger and settings keys: nothing
 * here can move a call, a key or a limit from one route (and payer) to another.
 *
 * Google Vertex AI has no key to paste. Connecting it names the Google Cloud
 * project to bill and records the identity of the Application Default
 * Credentials file on this computer; each turn mints a short-lived token from
 * exactly that file. Finding gcloud credentials here grants nothing: nothing is
 * sent to Google by any setup route, and nothing is spent until the owner
 * approves a limit and a conversation sends a message.
 */
import path from 'node:path';
import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { dollars, micro } from '../../shared/managed-usage.js';
import type {
  AzureConnectionView,
  DeclaredRatesView,
  ModelApiReadiness,
  ModelApiRoute,
  ModelApiSpendView,
  OpenRouterConnectionView,
  VertexConnectionView,
} from '../../shared/model-api.js';
import { FileModelTranscripts } from '../harness/model-transcripts.js';
import { secretFingerprint } from '../connection-secrets.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import {
  AZURE_API_VERSION,
  AZURE_CONNECTION_ID,
  AZURE_DEPLOYMENT,
  AZURE_LOGICAL_MODEL,
  AZURE_OPENAI_ROUTE,
  AZURE_RESOURCE,
  azureAccountRoute,
  azureConnectionSchema,
  azureEndpoint,
  azureRateCard,
  type AzureConnection,
} from './azure-openai.js';
import type { DeclaredRates } from './model-api-core.js';
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_CONNECTION_ID,
  OPENROUTER_MODEL,
  OPENROUTER_ROUTE,
  OPENROUTER_UPSTREAM,
  openRouterAccountRoute,
  openRouterConnectionSchema,
  openRouterRateCard,
  type OpenRouterConnection,
} from './openrouter.js';
import type { EngineService, ModelApiServices } from './service.js';
import {
  GOOGLE_VERTEX_ROUTE,
  readAdcIdentity,
  VERTEX_CONNECTION_ID,
  VERTEX_GEMINI_MODEL,
  VERTEX_LOCATION,
  VERTEX_PROJECT,
  VERTEX_RATE_CARDS,
  vertexAccounting,
  vertexAccountRoute,
  vertexBaseUrl,
  vertexConnectionSchema,
  vertexRateCard,
  VertexConnections,
  type VertexConnection,
} from './google-vertex.js';

const RECENT_HOLDS = 20;

/** Dollars per million tokens as the owner reads them on a price page; stored as whole micro-USD. */
const price = z.number().positive().max(1_000).transform((usd) => Math.round(usd * 1_000_000));
const optionalPrice = z.number().nonnegative().max(1_000).nullable().transform((usd) => (usd === null ? null : Math.round(usd * 1_000_000)));
const ratesBody = z.strictObject({
  inputUsdPerMillion: price,
  outputUsdPerMillion: price,
  cacheReadUsdPerMillion: optionalPrice,
  cacheWriteUsdPerMillion: optionalPrice,
  source: z.string().trim().min(1, 'Say where these prices come from.').max(300),
});
const declared = (body: z.infer<typeof ratesBody>, at: string): DeclaredRates => ({
  input: body.inputUsdPerMillion,
  output: body.outputUsdPerMillion,
  cacheRead: body.cacheReadUsdPerMillion,
  cacheWrite: body.cacheWriteUsdPerMillion,
  source: body.source,
  declaredAt: at,
});
const credentialBody = {
  apiKey: z.string().min(20).max(16_384),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  consent: z.literal(true),
};
const azureBody = z.strictObject({
  resourceName: z.string().regex(AZURE_RESOURCE, 'Enter the Azure OpenAI resource name (lowercase letters, digits and hyphens).'),
  deployments: z
    .array(
      z.strictObject({
        model: z.string().regex(AZURE_LOGICAL_MODEL, 'Name the model, for example gpt-5.6-luna.'),
        deployment: z.string().regex(AZURE_DEPLOYMENT, 'Enter the deployment name exactly as Azure shows it.'),
        reasoning: z.boolean(),
        rates: ratesBody,
      }),
    )
    .min(1, 'Add at least one deployment.')
    .max(16),
  ...credentialBody,
});
const openRouterBody = z.strictObject({
  models: z
    .array(
      z.strictObject({
        id: z.string().regex(OPENROUTER_MODEL, 'Enter a model id such as vendor/model, with no :variant.'),
        upstreams: z.array(z.string().regex(OPENROUTER_UPSTREAM)).min(1, 'Choose at least one endpoint for each model.').max(8),
        rates: ratesBody,
      }),
    )
    .min(1, 'Allow at least one model.')
    .max(16),
  ...credentialBody,
});
const vertexBody = z.strictObject({
  projectId: z.string().regex(VERTEX_PROJECT, 'Enter the Google Cloud project id (lowercase letters, digits and hyphens).'),
  location: z.literal(VERTEX_LOCATION),
  model: z.literal(VERTEX_GEMINI_MODEL),
  /** The owner confirms this project, and no other, is billed for every call. */
  consent: z.literal(true),
  /**
   * A Vertex API key created in this project. Absent: the computer's ADC sign-in is
   * used. The key goes straight to protected storage and is never echoed back.
   */
  apiKey: z.string().trim().regex(/^[\x21-\x7e]{20,200}$/, 'That does not look like a Google API key.').optional(),
});
const limitBody = z.strictObject({ capUsd: z.number().min(0).max(100).multipleOf(0.01), consent: z.literal(true) });
const reconcileBody = z.strictObject({ microUsd: z.number().int().min(0), note: z.string().trim().min(1).max(500) });
const writeOffBody = z.strictObject({ note: z.string().trim().min(1).max(500) });

interface Connected {
  id: string;
  revision: number;
  credential: { fingerprint: string; expiresAt: string | null };
}
interface RouteSpec<C extends Connected> {
  route: ModelApiRoute;
  /** The connection record's schema: a draft is checked in full before its key is stored. */
  schema: { parse(value: unknown): C };
  label: string;
  connectionId: string;
  services(api: ModelApiServices): { connections: { read(): Promise<C | null>; write(c: C): Promise<C>; remove(): Promise<void> } } | undefined;
  accountRoute(connection: C): string;
  defaultModel(connection: C): string;
  rateCardVersions(connection: C): string;
}

const expiredAt = (expiresAt: string | null) => !!expiresAt && Date.parse(expiresAt) <= Date.now() + 60_000;
const ratesView = (rates: DeclaredRates): DeclaredRatesView => ({ ...rates });

export function mountProviderRoutes(
  app: Express,
  deps: { store: Store; engines: EngineService },
  route: (action: (req: Request) => Promise<unknown>) => RequestHandler,
) {
  const { store, engines } = deps;
  const api = () => {
    if (!engines.modelApi) throw new ApiError(503, 'The model-API runtime is not available.');
    return engines.modelApi;
  };
  // Vertex keeps its own record and private transcripts beside the other routes'. Mounted here
  // because this is where every model-API route is attached; an app that supplies its own
  // (tests, a later integration in app.ts) keeps it.
  if (engines.modelApi && !engines.modelApi.vertex)
    engines.modelApi.vertex = {
      connections: new VertexConnections(store.dataDir),
      transcripts: new FileModelTranscripts(path.join(store.dataDir, 'model-transcripts-google-vertex'), GOOGLE_VERTEX_ROUTE),
    };

  function mount<C extends Connected, V>(spec: RouteSpec<C>, view: (connection: C | null, common: {
    protectedStorage: boolean;
    enabled: boolean;
    spend: ModelApiSpendView | null;
    next: string | null;
  }) => V, save: (req: Request, previous: C | null, fingerprint: string, at: string) => C) {
    const BASE = `/api/ai/model-api/${spec.route}`;
    const services = () => {
      const found = spec.services(api());
      if (!found) throw new ApiError(503, `The ${spec.label} route is not available in this process.`);
      return found;
    };
    const build = async (): Promise<V> => {
      const { secrets, exposure } = api();
      const connection = await services().connections.read();
      const protectedStorage = secrets.available();
      const enabled = store.settings.services?.[spec.route] === true;
      const summary = connection ? exposure.summary(connection.id) : null;
      const allowance = connection ? exposure.allowance(connection.id) : null;
      const next = !protectedStorage
        ? `Open the Diomedes desktop app to connect ${spec.label}: this process has no protected credential storage.`
        : !connection
          ? `Connect ${spec.label}.`
          : expiredAt(connection.credential.expiresAt)
            ? `The saved ${spec.label} key has expired. Enter a new key.`
            : !allowance || !summary || summary.availableMicroUsd <= 0
              ? `Approve a spend limit for ${spec.label} before sending.`
              : !enabled
                ? `Turn ${spec.label} on.`
                : null;
      const spend: ModelApiSpendView | null =
        connection && summary
          ? {
              rateCard: spec.rateCardVersions(connection),
              capMicroUsd: summary.capMicroUsd,
              settledMicroUsd: summary.settledMicroUsd,
              pendingMicroUsd: summary.pendingMicroUsd,
              uncertainMicroUsd: summary.uncertainMicroUsd,
              writtenOffMicroUsd: summary.writtenOffMicroUsd,
              availableMicroUsd: summary.availableMicroUsd,
              note: `Estimated from the prices you declared and the usage ${spec.label} reports for each call. It is Diomedes’ own limit, not a ${spec.label} billing cap, and not your invoice.`,
              recent: exposure
                .list(connection.id)
                .slice(-RECENT_HOLDS)
                .reverse()
                .map((hold) => ({
                  id: hold.id,
                  state: hold.state,
                  runId: hold.attempt.runId,
                  stepId: hold.attempt.stepId,
                  maxMicroUsd: hold.maxMicroUsd,
                  settledMicroUsd: hold.settledMicroUsd,
                  usage: hold.usage,
                  providerRequestId: hold.providerRequestId,
                  createdAt: hold.createdAt,
                  uncertainReason: hold.uncertainReason,
                })),
            }
          : null;
      return view(connection, { protectedStorage, enabled, spend, next });
    };
    /** A hold is reconciled only on the connection that made it. */
    const ownHold = async (holdId: string) => {
      const connection = await services().connections.read();
      if (!connection || !api().exposure.list(connection.id).some((hold) => hold.id === holdId))
        throw new ApiError(404, `That call is not on this ${spec.label} connection.`);
    };

    app.get(BASE, route(build));

    app.put(
      BASE,
      route((req) =>
        store.locked(async () => {
          const { secrets } = api();
          const { connections } = services();
          if (!secrets.available())
            throw new ApiError(409, 'Protected credential storage is available only in the Diomedes desktop app. Nothing was saved.');
          const previous = await connections.read();
          const at = new Date().toISOString();
          const apiKey = String((req.body as { apiKey?: unknown } | null)?.apiKey ?? '');
          // Validate everything before the key is stored.
          const draft = spec.schema.parse(save(req, previous, secretFingerprint(apiKey), at));
          const { fingerprint } = await secrets.put(spec.connectionId, apiKey);
          if (fingerprint !== draft.credential.fingerprint)
            throw new ApiError(500, 'The saved credential does not match what was entered.');
          const connection = await connections.write(draft);
          await store.saveSettings({
            ...store.settings,
            services: {
              ...store.settings.services,
              [spec.route]: true,
              [`${spec.route}Model`]: spec.defaultModel(connection),
              [`${spec.route}AccountRoute`]: spec.accountRoute(connection),
            },
          });
          return build();
        }),
      ),
    );

    app.post(
      `${BASE}/test`,
      route(async (): Promise<ModelApiReadiness> => {
        const { secrets, exposure } = api();
        const connection = await services().connections.read();
        const checks: ModelApiReadiness['checks'] = [];
        const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
        check('protected-storage', secrets.available(), secrets.available() ? 'Protected credential storage is available.' : 'This process has no protected credential storage.');
        check('connection', !!connection, connection ? `Connection ${spec.accountRoute(connection)} is saved.` : `No ${spec.label} connection is saved.`);
        if (connection) {
          let keyOk = false;
          let detail = 'The saved key matches the connection record.';
          try {
            keyOk = secretFingerprint(await secrets.get(connection.id)) === connection.credential.fingerprint;
            if (!keyOk) detail = 'The saved key does not match the connection record. Enter it again.';
          } catch (error) {
            detail = error instanceof Error ? error.message : 'The saved key could not be read.';
          }
          check('credential', keyOk, detail);
          const expired = expiredAt(connection.credential.expiresAt);
          check('expiry', !expired, expired ? 'The saved key has expired.' : 'The saved key has not expired.');
          const summary = exposure.allowance(connection.id) ? exposure.summary(connection.id) : null;
          check(
            'spend-limit',
            !!summary && summary.availableMicroUsd > 0,
            summary ? `${summary.availableMicroUsd} micro-USD of the approved limit is available.` : 'No spend limit is approved.',
          );
        }
        const enabled = store.settings.services?.[spec.route] === true;
        check('enabled', enabled, enabled ? `${spec.label} is switched on.` : `${spec.label} is switched off.`);
        return {
          route: spec.route,
          ready: checks.every((entry) => entry.ok),
          sent: false,
          checks,
          note: `No request was sent to ${spec.label}. This checks the saved connection, key and spend limit only; whether ${spec.label} accepts the key is known only from a real call.`,
        };
      }),
    );

    app.put(
      `${BASE}/spend-limit`,
      route((req) =>
        store.locked(async () => {
          const body = limitBody.parse(req.body);
          const connection = await services().connections.read();
          if (!connection) throw new ApiError(409, `Connect ${spec.label} before approving a spend limit.`);
          await api().exposure.setCap(connection.id, dollars(Math.round(body.capUsd * 100) / 100), {
            approvedBy: 'the owner, in AI setup on this computer',
            note: 'Aggregate estimated exposure for this connection. Reopening or reconnecting never resets it.',
          });
          return build();
        }),
      ),
    );

    app.post(
      `${BASE}/holds/:holdId/reconcile`,
      route((req) =>
        store.locked(async () => {
          const body = reconcileBody.parse(req.body);
          const holdId = String(req.params.holdId);
          await ownHold(holdId);
          await api().exposure.reconcile(holdId, { microUsd: micro(body.microUsd), note: body.note });
          return build();
        }),
      ),
    );

    app.post(
      `${BASE}/holds/:holdId/write-off`,
      route((req) =>
        store.locked(async () => {
          const body = writeOffBody.parse(req.body);
          const holdId = String(req.params.holdId);
          await ownHold(holdId);
          await api().exposure.writeOff(holdId, { note: body.note });
          return build();
        }),
      ),
    );

    app.delete(
      BASE,
      route(() =>
        store.locked(async () => {
          await api().secrets.remove(spec.connectionId);
          await services().connections.remove();
          const settings: Record<string, boolean | string> = { ...store.settings.services, [spec.route]: false };
          delete settings[`${spec.route}AccountRoute`];
          await store.saveSettings({ ...store.settings, services: settings });
          return build();
        }),
      ),
    );
  }

  mount<AzureConnection, AzureConnectionView>(
    {
      route: AZURE_OPENAI_ROUTE,
      schema: azureConnectionSchema,
      label: 'Azure OpenAI',
      connectionId: AZURE_CONNECTION_ID,
      services: (services) => services.azure,
      accountRoute: azureAccountRoute,
      defaultModel: (connection) => connection.deployments[0].model,
      rateCardVersions: (connection) =>
        connection.deployments.map((entry) => azureRateCard(connection, entry.model).version).join(' '),
    },
    (connection, common) => ({
      route: AZURE_OPENAI_ROUTE,
      configured: !!connection,
      protectedStorage: common.protectedStorage,
      enabled: common.enabled,
      connection: connection
        ? {
            id: connection.id,
            resource: connection.resourceName,
            endpoint: connection.baseUrl,
            apiVersion: connection.apiVersion,
            deployments: connection.deployments.map((entry) => ({
              model: entry.model,
              deployment: entry.deployment,
              reasoning: entry.reasoning,
              rates: ratesView(entry.rates),
            })),
            credential: { ...connection.credential, expired: expiredAt(connection.credential.expiresAt) },
            revision: connection.revision,
            accountRoute: azureAccountRoute(connection),
          }
        : null,
      spend: common.spend,
      next: common.next,
    }),
    (req, previous, fingerprint, at) => {
      const body = azureBody.parse(req.body);
      return {
        v: 1,
        id: AZURE_CONNECTION_ID,
        resourceName: body.resourceName,
        baseUrl: azureEndpoint(body.resourceName),
        apiVersion: AZURE_API_VERSION,
        deployments: body.deployments.map((entry) => ({
          model: entry.model,
          deployment: entry.deployment,
          reasoning: entry.reasoning,
          rates: declared(entry.rates, at),
        })),
        credential: { kind: 'azure-api-key', fingerprint, savedAt: at, expiresAt: body.expiresAt },
        // Every save is a new generation: a result from a call made under the old key, resource
        // or prices is refused when it comes back.
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      };
    },
  );

  mount<OpenRouterConnection, OpenRouterConnectionView>(
    {
      route: OPENROUTER_ROUTE,
      schema: openRouterConnectionSchema,
      label: 'OpenRouter',
      connectionId: OPENROUTER_CONNECTION_ID,
      services: (services) => services.openrouter,
      accountRoute: openRouterAccountRoute,
      defaultModel: (connection) => connection.models[0].id,
      rateCardVersions: (connection) =>
        connection.models.map((entry) => openRouterRateCard(connection, entry.id).version).join(' '),
    },
    (connection, common) => ({
      route: OPENROUTER_ROUTE,
      configured: !!connection,
      protectedStorage: common.protectedStorage,
      enabled: common.enabled,
      connection: connection
        ? {
            id: connection.id,
            endpoint: connection.baseUrl,
            models: connection.models.map((entry) => ({
              id: entry.id,
              upstreams: [...entry.upstreams],
              rates: ratesView(entry.rates),
            })),
            dataCollection: connection.dataCollection,
            allowFallbacks: connection.allowFallbacks,
            credential: { ...connection.credential, expired: expiredAt(connection.credential.expiresAt) },
            revision: connection.revision,
            accountRoute: openRouterAccountRoute(connection),
          }
        : null,
      spend: common.spend,
      next: common.next,
    }),
    (req, previous, fingerprint, at) => {
      const body = openRouterBody.parse(req.body);
      return {
        v: 1,
        id: OPENROUTER_CONNECTION_ID,
        baseUrl: OPENROUTER_BASE_URL,
        models: body.models.map((entry) => ({
          id: entry.id,
          upstreams: [...entry.upstreams],
          rates: declared(entry.rates, at),
        })),
        dataCollection: 'deny',
        allowFallbacks: false,
        credential: { kind: 'openrouter-api-key', fingerprint, savedAt: at, expiresAt: body.expiresAt },
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      };
    },
  );

  // --- Google Vertex AI: no key; the project and the verified ADC identity ------------------
  {
    const BASE = `/api/ai/model-api/${GOOGLE_VERTEX_ROUTE}`;
    const services = () => {
      const found = api().vertex;
      if (!found) throw new ApiError(503, 'The Google Vertex AI route is not available in this process.');
      return found;
    };
    /** Whether protected storage still holds the key this record was connected with. Never returns the key. */
    const storedKeyMatches = async (connection: VertexConnection) => {
      if (connection.credential.kind !== 'google-api-key' || !api().secrets.available()) return false;
      try {
        return secretFingerprint(await api().secrets.get(connection.id)) === connection.credential.fingerprint;
      } catch {
        return false;
      }
    };
    const currentCard = () => {
      try {
        return { card: vertexRateCard(services().now?.() ?? new Date()), message: null as string | null };
      } catch (error) {
        return { card: null, message: error instanceof Error ? error.message : 'No current price is recorded.' };
      }
    };
    const build = async (): Promise<VertexConnectionView> => {
      const { exposure } = api();
      const connection = await services().connections.read();
      const identity = await readAdcIdentity(services().env);
      const enabled = store.settings.services?.[GOOGLE_VERTEX_ROUTE] === true;
      const summary = connection ? exposure.summary(connection.id) : null;
      const allowance = connection ? exposure.allowance(connection.id) : null;
      const keyed = connection?.credential.kind === 'google-api-key';
      const matches = !!connection && (keyed ? await storedKeyMatches(connection) : !!identity && identity.fingerprint === connection.credential.fingerprint);
      const price = currentCard();
      const holds = connection ? exposure.list(connection.id) : [];
      const answered = [...holds].reverse().find((hold) => hold.state === 'settled' && hold.reconciledFrom === 'response');
      const next = !connection
        ? identity
          ? 'Connect Google Vertex AI: name the Google Cloud project that is billed.'
          : 'Connect Google Vertex AI with the billed project and an API key from it, or sign in with `gcloud auth application-default login` first.'
        : !matches
          ? keyed
            ? 'The saved Google Vertex AI key is missing or not the one connected. Connect it again.'
            : 'The Google credential on this computer changed. Connect Google Vertex AI again to verify it.'
            : !price.card
              ? price.message
              : !allowance || !summary || summary.availableMicroUsd <= 0
                ? 'Approve a spend limit for Google Vertex AI before sending.'
                : !enabled
                  ? 'Turn Google Vertex AI on.'
                  : null;
      return {
        route: GOOGLE_VERTEX_ROUTE,
        configured: !!connection,
        enabled,
        detected: {
          adc: !!identity,
          source: identity?.source ?? null,
          namedBy: identity?.namedBy ?? null,
          quotaProject: identity?.quotaProject ?? null,
        },
        connection: connection
          ? {
              id: connection.id,
              projectId: connection.projectId,
              location: connection.location,
              endpoint: connection.baseUrl,
              model: connection.model,
              processing: connection.processing,
              payer: connection.payer,
              credential:
                connection.credential.kind === 'google-api-key'
                  ? { kind: 'google-api-key' as const, savedAt: connection.credential.savedAt, matches }
                  : {
                      kind: 'google-adc' as const,
                      source: connection.credential.source,
                      namedBy: connection.credential.namedBy,
                      fingerprint: connection.credential.fingerprint,
                      principal: connection.credential.principal,
                      quotaProject: connection.credential.quotaProject,
                      savedAt: connection.credential.savedAt,
                      matches,
                    },
              rateCard: {
                version: price.card?.version ?? VERTEX_RATE_CARDS[VERTEX_RATE_CARDS.length - 1].card.version,
                source: price.card?.source ?? '',
                stale: !price.card,
                message: price.message,
              },
              revision: connection.revision,
              accountRoute: vertexAccountRoute(connection),
              lastVerified: answered
                ? { at: answered.resolvedAt ?? answered.createdAt, state: answered.state, providerRequestId: answered.providerRequestId }
                : null,
            }
          : null,
        spend:
          connection && summary
            ? {
                rateCard: price.card?.version ?? 'none in force',
                capMicroUsd: summary.capMicroUsd,
                settledMicroUsd: summary.settledMicroUsd,
                pendingMicroUsd: summary.pendingMicroUsd,
                uncertainMicroUsd: summary.uncertainMicroUsd,
                writtenOffMicroUsd: summary.writtenOffMicroUsd,
                availableMicroUsd: summary.availableMicroUsd,
                note: 'Estimated from Google’s published Gemini 3.8 Flash prices and the usage Vertex reports for each call. It is Nectovia’s own limit, not a Google billing cap, not your invoice, and it says nothing about whether Google Cloud credits paid for a call.',
                recent: holds
                  .slice(-RECENT_HOLDS)
                  .reverse()
                  .map((hold) => ({
                    id: hold.id,
                    state: hold.state,
                    runId: hold.attempt.runId,
                    stepId: hold.attempt.stepId,
                    maxMicroUsd: hold.maxMicroUsd,
                    settledMicroUsd: hold.settledMicroUsd,
                    usage: hold.usage,
                    providerRequestId: hold.providerRequestId,
                    createdAt: hold.createdAt,
                    uncertainReason: hold.uncertainReason,
                  })),
              }
            : null,
        accounting:
          connection && summary
            ? vertexAccounting(connection.payer.projectId, summary, services().now?.() ?? new Date())
            : null,
        next,
      };
    };
    const ownHold = async (holdId: string) => {
      const connection = await services().connections.read();
      if (!connection || !api().exposure.list(connection.id).some((hold) => hold.id === holdId))
        throw new ApiError(404, 'That call is not on this Google Vertex AI connection.');
    };

    app.get(BASE, route(build));

    // Connecting records which project is billed and which ADC identity may be used. Nothing is
    // sent to Google: whether Google accepts the credential is known only from a real call.
    app.put(
      BASE,
      route((req) =>
        store.locked(async () => {
          const body = vertexBody.parse(req.body);
          const { secrets } = api();
          const identity = body.apiKey ? null : await readAdcIdentity(services().env);
          if (body.apiKey && !secrets.available())
            throw new ApiError(409, 'Protected credential storage is available only in the Diomedes desktop app. Nothing was saved.');
          if (!body.apiKey && !identity)
            throw new ApiError(
              409,
              'No Google Application Default Credentials were found on this computer. Enter an API key from the project, or run `gcloud auth application-default login` first. Nothing was saved.',
            );
          const previous = await services().connections.read();
          const at = new Date().toISOString();
          const credential = body.apiKey
            ? { kind: 'google-api-key' as const, fingerprint: secretFingerprint(body.apiKey), savedAt: at, expiresAt: null }
            : {
                kind: 'google-adc' as const,
                source: identity!.source,
                namedBy: identity!.namedBy,
                fingerprint: identity!.fingerprint,
                principal: identity!.principal,
                quotaProject: identity!.quotaProject,
                savedAt: at,
                expiresAt: null,
              };
          const draft: VertexConnection = vertexConnectionSchema.parse({
            v: 1,
            id: VERTEX_CONNECTION_ID,
            projectId: body.projectId,
            location: body.location,
            baseUrl: vertexBaseUrl(body.projectId),
            model: body.model,
            processing: 'google-global',
            payer: { kind: 'google-cloud-project', projectId: body.projectId },
            credential,
            // Every save is a new generation: saved context and results from before are refused.
            revision: (previous?.revision ?? 0) + 1,
            createdAt: previous?.createdAt ?? at,
            updatedAt: at,
          });
          // Validated first. A key is stored for the record about to be written, and taken back out
          // if that write fails, unless the previous record still uses a key there. Connecting
          // with ADC always clears the slot, so no key outlives the record that named it.
          let connection: VertexConnection;
          if (body.apiKey) {
            await secrets.put(VERTEX_CONNECTION_ID, body.apiKey);
            try {
              connection = await services().connections.write(draft);
            } catch (error) {
              if (previous?.credential.kind !== 'google-api-key') await secrets.remove(VERTEX_CONNECTION_ID).catch(() => undefined);
              throw error;
            }
          } else {
            await secrets.remove(VERTEX_CONNECTION_ID);
            connection = await services().connections.write(draft);
          }
          await store.saveSettings({
            ...store.settings,
            services: {
              ...store.settings.services,
              [GOOGLE_VERTEX_ROUTE]: true,
              [`${GOOGLE_VERTEX_ROUTE}Model`]: connection.model,
              [`${GOOGLE_VERTEX_ROUTE}AccountRoute`]: vertexAccountRoute(connection),
            },
          });
          return build();
        }),
      ),
    );

    app.post(
      `${BASE}/test`,
      route(async (): Promise<ModelApiReadiness> => {
        const { exposure } = api();
        const connection = await services().connections.read();
        const identity = await readAdcIdentity(services().env);
        const checks: ModelApiReadiness['checks'] = [];
        const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
        check('connection', !!connection, connection ? `Connection ${vertexAccountRoute(connection)} bills project ${connection.projectId}.` : 'No Google Vertex AI connection is saved.');
        if (connection?.credential.kind === 'google-api-key') {
          const ok = await storedKeyMatches(connection);
          check('credential', ok, ok ? 'The saved API key is the one connected.' : 'The saved API key is missing or not the one connected. Connect again.');
        } else {
          check('adc', !!identity, identity ? `Application Default Credentials found (${identity.source}).` : 'No Application Default Credentials file was found.');
        }
        if (connection) {
          if (connection.credential.kind === 'google-adc') {
            const matches = !!identity && identity.fingerprint === connection.credential.fingerprint;
            check('credential', matches, matches ? 'The credential on this computer is the one verified.' : 'The credential on this computer is not the one verified. Connect again.');
          }
          const price = currentCard();
          check('price', !!price.card, price.card ? `Priced under ${price.card.version}.` : (price.message ?? 'No current price.'));
          const summary = exposure.allowance(connection.id) ? exposure.summary(connection.id) : null;
          check('spend-limit', !!summary && summary.availableMicroUsd > 0, summary ? `${summary.availableMicroUsd} micro-USD of the approved limit is available.` : 'No spend limit is approved.');
        }
        const enabled = store.settings.services?.[GOOGLE_VERTEX_ROUTE] === true;
        check('enabled', enabled, enabled ? 'Google Vertex AI is switched on.' : 'Google Vertex AI is switched off.');
        return {
          route: GOOGLE_VERTEX_ROUTE,
          ready: checks.every((entry) => entry.ok),
          sent: false,
          checks,
          note: 'No request was sent to Google. This checks the saved project, the local credential, the price and the spend limit only; whether Google accepts the credential and bills the project is known only from a real call and the project’s billing report.',
        };
      }),
    );

    app.put(
      `${BASE}/spend-limit`,
      route((req) =>
        store.locked(async () => {
          const body = limitBody.parse(req.body);
          const connection = await services().connections.read();
          if (!connection) throw new ApiError(409, 'Connect Google Vertex AI before approving a spend limit.');
          await api().exposure.setCap(connection.id, dollars(Math.round(body.capUsd * 100) / 100), {
            approvedBy: 'the owner, in AI setup on this computer',
            note: 'Aggregate estimated exposure for this connection. Reopening or reconnecting never resets it.',
          });
          return build();
        }),
      ),
    );

    app.post(
      `${BASE}/holds/:holdId/reconcile`,
      route((req) =>
        store.locked(async () => {
          const body = reconcileBody.parse(req.body);
          const holdId = String(req.params.holdId);
          await ownHold(holdId);
          await api().exposure.reconcile(holdId, { microUsd: micro(body.microUsd), note: body.note });
          return build();
        }),
      ),
    );

    app.post(
      `${BASE}/holds/:holdId/write-off`,
      route((req) =>
        store.locked(async () => {
          const body = writeOffBody.parse(req.body);
          const holdId = String(req.params.holdId);
          await ownHold(holdId);
          await api().exposure.writeOff(holdId, { note: body.note });
          return build();
        }),
      ),
    );

    app.delete(
      BASE,
      route(() =>
        store.locked(async () => {
          await api().secrets.remove(VERTEX_CONNECTION_ID);
          await services().connections.remove();
          const settings: Record<string, boolean | string> = { ...store.settings.services, [GOOGLE_VERTEX_ROUTE]: false };
          delete settings[`${GOOGLE_VERTEX_ROUTE}AccountRoute`];
          await store.saveSettings({ ...store.settings, services: settings });
          return build();
        }),
      ),
    );
  }
}
