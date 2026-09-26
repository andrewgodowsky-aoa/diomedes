/**
 * Setup for the AWS Bedrock model-API route: connect it, approve its spend
 * limit, reconcile an uncertain call, disconnect it.
 *
 *   GET    /api/ai/model-api/aws-bedrock                         the connection, as identifiers and state
 *   PUT    /api/ai/model-api/aws-bedrock                         save account, model and key; switch the route on
 *   PUT    /api/ai/model-api/aws-bedrock/spend-limit             the owner's approved aggregate spend exposure
 *   POST   /api/ai/model-api/aws-bedrock/holds/:id/reconcile     record an uncertain call's actual cost
 *   POST   /api/ai/model-api/aws-bedrock/holds/:id/write-off     accept an uncertain call as spent at its ceiling
 *   DELETE /api/ai/model-api/aws-bedrock                         forget the key; switch the route off
 *   GET    /api/projects/:id/model-sessions/:runId               a model-API conversation run's status
 *   POST   /api/projects/:id/model-sessions/:runId/interrupt     stop the turn in progress
 *
 * The key goes one way: into protected storage. No route reads it back, no
 * Settings field holds it and no response contains it. Spend records are never
 * deleted by disconnecting, reconnecting or reinstalling.
 *
 * The Azure OpenAI and OpenRouter routes' setup mirrors this and is mounted from
 * here (`provider-routes.ts`), so the app mounts every model-API route in one place.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { dollars, micro } from '../../shared/managed-usage.js';
import type { AwsConnectionView } from '../../shared/model-api.js';
import { secretFingerprint } from '../connection-secrets.js';
import { HarnessError } from '../harness/policy.js';
import { ApiError } from '../paths.js';
import { SpendExposureError } from '../spend-exposure.js';
import type { Store } from '../store.js';
import {
  accountEvidence,
  AWS_BEDROCK_ROUTE,
  AWS_LUNA_MODEL,
  AWS_LUNA_RATE_CARD,
  AWS_RESPONSES_ENDPOINTS,
  awsAccountRoute,
  AwsConnectionRetired,
  redactedAccount,
  type AwsConnection,
  type AwsConnections,
} from './aws-bedrock.js';
import { EngineError } from './process.js';
import { mountProviderRoutes } from './provider-routes.js';
import type { EngineService } from './service.js';

const BASE = `/api/ai/model-api/${AWS_BEDROCK_ROUTE}`;
const CONNECTION_ID = 'aws-bedrock-1';
/** Enough recent calls to inspect a conversation's usage; the ledger keeps them all. */
const RECENT_HOLDS = 20;

const connectBody = z.strictObject({
  accountId: z.string().regex(/^\d{12}$/, 'Enter the 12-digit AWS account number.'),
  region: z.literal('us-east-1'),
  model: z.literal(AWS_LUNA_MODEL),
  apiKey: z.string().min(20).max(16_384),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  consent: z.literal(true),
});
const limitBody = z.strictObject({
  /** Whole cents, at most $100 for this route. */
  capUsd: z.number().min(0).max(100).multipleOf(0.01),
  consent: z.literal(true),
});
const reconcileBody = z.strictObject({ microUsd: z.number().int().min(0), note: z.string().trim().min(1).max(500) });
const writeOffBody = z.strictObject({ note: z.string().trim().min(1).max(500) });
const controlBody = z.strictObject({ commandId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/) });

/** The saved connection, or the retired record in its place. Any other unreadable record throws. */
async function savedConnection(
  connections: Pick<AwsConnections, 'read'>,
): Promise<{ connection: AwsConnection | null; retired: AwsConnectionRetired | null }> {
  try {
    return { connection: await connections.read(), retired: null };
  } catch (error) {
    if (error instanceof AwsConnectionRetired) return { connection: null, retired: error };
    throw error;
  }
}

export function mountModelApiRoutes(app: Express, deps: { store: Store; engines: EngineService }) {
  const { store, engines } = deps;
  const api = () => {
    if (!engines.modelApi) throw new ApiError(503, 'The model-API runtime is not available.');
    return engines.modelApi;
  };
  const route =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await action(req));
      } catch (error) {
        if (error instanceof z.ZodError)
          next(new ApiError(400, error.issues[0]?.message ?? 'That request is not valid.'));
        else if (error instanceof SpendExposureError) next(new ApiError(error.status, error.message, { code: error.code }));
        else if (error instanceof EngineError || error instanceof HarnessError)
          next(new ApiError(409, error.message, { code: error.code }));
        else next(error);
      }
    };

  const view = async (): Promise<AwsConnectionView> => {
    const { connections, secrets, exposure } = api();
    // A connection an earlier version saved for a retired model shows as not set up, with the
    // reconnect sentence as the next step.
    const { connection, retired } = await savedConnection(connections);
    const protectedStorage = secrets.available();
    const enabled = store.settings.services?.[AWS_BEDROCK_ROUTE] === true;
    const expired =
      !!connection?.credential.expiresAt && Date.parse(connection.credential.expiresAt) <= Date.now() + 60_000;
    const summary = connection ? exposure.summary(connection.id) : null;
    const allowance = connection ? exposure.allowance(connection.id) : null;
    const next = !protectedStorage
      ? 'Open the Diomedes desktop app to connect AWS: this process has no protected credential storage.'
      : retired
        ? retired.message
        : !connection
          ? 'Connect your AWS account: account number and a Bedrock API key.'
          : expired
            ? 'The saved AWS key has expired. Enter a new key.'
            : !allowance || !summary || summary.availableMicroUsd <= 0
              ? 'Approve a spend limit for AWS before sending.'
              : !enabled
                ? 'Turn AWS Bedrock on.'
                : null;
    return {
      route: AWS_BEDROCK_ROUTE,
      configured: !!connection,
      protectedStorage,
      enabled,
      connection: connection
        ? {
            id: connection.id,
            account: redactedAccount(connection.accountId),
            accountEvidence,
            region: connection.region,
            endpoint: connection.baseUrl,
            model: connection.modelId,
            processing: connection.processing,
            credential: { ...connection.credential, expired },
            revision: connection.revision,
            accountRoute: awsAccountRoute(connection),
          }
        : null,
      spend:
        connection && summary
          ? {
              rateCard: AWS_LUNA_RATE_CARD.version,
              capMicroUsd: summary.capMicroUsd,
              settledMicroUsd: summary.settledMicroUsd,
              pendingMicroUsd: summary.pendingMicroUsd,
              uncertainMicroUsd: summary.uncertainMicroUsd,
              writtenOffMicroUsd: summary.writtenOffMicroUsd,
              availableMicroUsd: summary.availableMicroUsd,
              note: 'Estimated from AWS list prices and the usage AWS reports for each call. It is Diomedes’ own limit, not an AWS billing cap, and not your invoice.',
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
          : null,
      next,
    };
  };

  app.get(BASE, route(view));

  app.put(
    BASE,
    route((req) =>
      store.locked(async () => {
        const body = connectBody.parse(req.body);
        const { connections, secrets } = api();
        if (!secrets.available())
          throw new ApiError(409, 'Protected credential storage is available only in the Diomedes desktop app. Nothing was saved.');
        // Reconnecting over a retired connection continues its revision and first-saved time.
        const { connection: current, retired } = await savedConnection(connections);
        const previous = current ?? retired?.retired ?? null;
        const at = new Date().toISOString();
        const { fingerprint } = await secrets.put(CONNECTION_ID, body.apiKey);
        const connection: AwsConnection = await connections.write({
          v: 1,
          id: CONNECTION_ID,
          accountId: body.accountId,
          region: body.region,
          baseUrl: AWS_RESPONSES_ENDPOINTS[body.region],
          modelId: body.model,
          processing: 'us-geo',
          credential: { kind: 'bedrock-api-key', fingerprint, savedAt: at, expiresAt: body.expiresAt },
          // Every save is a new generation: a result from a call made under the old key or
          // account is refused when it comes back.
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? at,
          updatedAt: at,
        });
        if (secretFingerprint(body.apiKey) !== connection.credential.fingerprint)
          throw new ApiError(500, 'The saved credential does not match what was entered.');
        await store.saveSettings({
          ...store.settings,
          services: {
            ...store.settings.services,
            [AWS_BEDROCK_ROUTE]: true,
            [`${AWS_BEDROCK_ROUTE}Model`]: connection.modelId,
            [`${AWS_BEDROCK_ROUTE}AccountRoute`]: awsAccountRoute(connection),
          },
        });
        return view();
      }),
    ),
  );

  app.put(
    `${BASE}/spend-limit`,
    route((req) =>
      store.locked(async () => {
        const body = limitBody.parse(req.body);
        const { connections, exposure } = api();
        const connection = await connections.read();
        if (!connection) throw new ApiError(409, 'Connect AWS before approving a spend limit.');
        await exposure.setCap(connection.id, dollars(Math.round(body.capUsd * 100) / 100), {
          approvedBy: 'the owner, in AI setup on this computer',
          note: 'Aggregate estimated exposure for this connection. Reopening or reconnecting never resets it.',
        });
        return view();
      }),
    ),
  );

  app.post(
    `${BASE}/holds/:holdId/reconcile`,
    route((req) =>
      store.locked(async () => {
        const body = reconcileBody.parse(req.body);
        await api().exposure.reconcile(String(req.params.holdId), { microUsd: micro(body.microUsd), note: body.note });
        return view();
      }),
    ),
  );

  app.post(
    `${BASE}/holds/:holdId/write-off`,
    route((req) =>
      store.locked(async () => {
        const body = writeOffBody.parse(req.body);
        await api().exposure.writeOff(String(req.params.holdId), { note: body.note });
        return view();
      }),
    ),
  );

  app.delete(
    BASE,
    route(() =>
      store.locked(async () => {
        const { connections, secrets } = api();
        await secrets.remove(CONNECTION_ID);
        await connections.remove();
        const services: Record<string, boolean | string> = { ...store.settings.services, [AWS_BEDROCK_ROUTE]: false };
        delete services[`${AWS_BEDROCK_ROUTE}AccountRoute`];
        await store.saveSettings({ ...store.settings, services });
        return view();
      }),
    ),
  );

  // A model-API conversation's status and Stop, beside the Claude session routes' own. The
  // conversation itself is sent only through the interaction messages route.
  const sessions = () => {
    if (!engines.modelSessions) throw new ApiError(503, 'The model-API conversation runtime is unavailable.');
    return engines.modelSessions;
  };
  const SESSIONS = '/api/projects/:id/model-sessions/:runId';
  const scoped = (req: Request) => {
    const projectId = String(req.params.id);
    store.state(projectId);
    return { projectId, runId: String(req.params.runId) };
  };
  app.get(
    SESSIONS,
    route(async (req) => {
      const { projectId, runId } = scoped(req);
      return sessions().status(projectId, runId);
    }),
  );
  app.post(
    `${SESSIONS}/interrupt`,
    route(async (req) => {
      const { projectId, runId } = scoped(req);
      const body = controlBody.parse(req.body);
      return sessions().control(projectId, runId, body.commandId, 'interrupt');
    }),
  );

  mountProviderRoutes(app, deps, route);
}
