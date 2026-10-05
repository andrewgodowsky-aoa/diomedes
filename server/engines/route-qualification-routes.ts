/**
 * The owner's route checks (`route-qualification.ts`), mounted beside each route's setup:
 *
 *   POST /api/ai/model-api/aws-bedrock/qualify                    { consent: true, effort? }
 *   GET  /api/ai/model-api/aws-bedrock/qualification              the AWS connection's newest receipt, and what it means now
 *   POST /api/ai/model-api/azure-openai/qualify                   { consent: true, model, effort? }
 *   GET  /api/ai/model-api/azure-openai/qualification?model=…     the same for one Azure deployment
 *
 * A run makes up to eight small live requests with the route's own key, held on the route's own
 * spend limit, and records one receipt. No response carries a key, a prompt or answer text: a
 * receipt holds identifiers, counts, states and sentences. A run can take minutes, so it takes no
 * store lock; one run at a time per connection, and closing the request stops it.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { RouteQualificationView } from '../../shared/model-api.js';
import {
  receiptQualifies,
  type QualifiableRoute,
  type QualificationIdentity,
  type RouteQualificationReceipt,
} from '../../shared/route-qualification.js';
import { secretFingerprint } from '../connection-secrets.js';
import { HarnessError } from '../harness/policy.js';
import { ApiError } from '../paths.js';
import {
  AWS_BEDROCK_ROUTE,
  AwsConnectionRetired,
  awsQualificationIdentity,
  awsQualificationTarget,
  awsRequiresQualification,
  type AwsConnection,
} from './aws-bedrock.js';
import {
  AZURE_OPENAI_ROUTE,
  azureDeploymentFor,
  azureQualificationIdentity,
  azureQualificationTarget,
  type AzureConnection,
} from './azure-openai.js';
import { ModelApiError } from './model-api-core.js';
import type { RouteQualifications } from './route-qualification-store.js';
import {
  plannedCeilingMicroUsd,
  QualificationRefused,
  qualificationRoom,
  runRouteQualification,
  type QualificationTarget,
} from './route-qualification.js';
import type { EngineService, ModelApiServices } from './service.js';

type Effort = 'low' | 'medium' | 'high';
const effort = z.enum(['low', 'medium', 'high']).optional();
const awsBody = z.strictObject({ consent: z.literal(true), effort });
const azureModel = z.string().min(1, 'Name the Azure model to check.').max(64);
const azureBody = z.strictObject({ consent: z.literal(true), model: azureModel, effort });

/** One route's state for the checks: its identity and target when connected, and why a run cannot start. */
interface Prepared {
  route: QualifiableRoute;
  model: string | null;
  deployment: string | null;
  required: boolean;
  /** Present when connected. */
  ready: {
    connectionId: string;
    fingerprint: string;
    identity: QualificationIdentity;
    target: QualificationTarget;
    ceilingMicroUsd: number;
  } | null;
  blocked: { code: string; message: string } | null;
}

export function mountQualificationRoutes(
  app: Express,
  deps: { engines: EngineService },
  route: (action: (req: Request) => Promise<unknown>) => RequestHandler,
) {
  const api = () => {
    if (!deps.engines.modelApi) throw new ApiError(503, 'The model-API runtime is not available.');
    return deps.engines.modelApi;
  };
  const receiptsOf = (services: ModelApiServices): RouteQualifications => {
    if (!services.qualifications) throw new ApiError(503, 'Route checks are not available in this process.');
    return services.qualifications;
  };
  /** Connections with a run in progress, by route and connection. */
  const running = new Set<string>();
  const runKey = (route: QualifiableRoute, connectionId: string) => `${route}:${connectionId}`;

  /** The reasons a run cannot start, in the order the owner meets them. */
  const admission = (
    services: ModelApiServices,
    input: {
      route: QualifiableRoute;
      label: string;
      long: string;
      connection: { id: string; credential: { expiresAt: string | null } } | null;
      retired?: string | null;
      ceilingMicroUsd: number | null;
    },
  ): Prepared['blocked'] => {
    if (!services.secrets.available())
      return {
        code: 'qualify_no_storage',
        message: 'Open the Diomedes desktop app to run route checks: this process has no protected credential storage.',
      };
    if (input.retired) return { code: 'qualify_no_connection', message: input.retired };
    if (!input.connection) return { code: 'qualify_no_connection', message: `Connect ${input.long} before running route checks.` };
    const expiresAt = input.connection.credential.expiresAt;
    if (expiresAt && Date.parse(expiresAt) <= Date.now() + 60_000)
      return {
        code: 'qualify_key_expired',
        message: `The saved ${input.label} key has expired. Enter a new key before running route checks.`,
      };
    if (running.has(runKey(input.route, input.connection.id)))
      return { code: 'qualify_running', message: 'Route checks are already running on this connection.' };
    return qualificationRoom(services.exposure, input.connection.id, input.ceilingMicroUsd ?? 0, input.label);
  };

  const prepareAws = async (services: ModelApiServices, level: Effort): Promise<Prepared> => {
    let connection: AwsConnection | null = null;
    let retired: string | null = null;
    try {
      connection = await services.connections.read();
    } catch (error) {
      if (!(error instanceof AwsConnectionRetired)) throw error;
      retired = error.message;
    }
    const target = connection ? awsQualificationTarget(connection, level) : null;
    const ceilingMicroUsd = target ? plannedCeilingMicroUsd(target) : null;
    return {
      route: AWS_BEDROCK_ROUTE,
      model: connection?.modelId ?? null,
      deployment: null,
      required: connection ? awsRequiresQualification(connection.modelId) : false,
      ready:
        connection && target && ceilingMicroUsd !== null
          ? {
              connectionId: connection.id,
              fingerprint: connection.credential.fingerprint,
              identity: awsQualificationIdentity(connection),
              target,
              ceilingMicroUsd,
            }
          : null,
      blocked: admission(services, { route: AWS_BEDROCK_ROUTE, label: 'AWS', long: 'AWS Bedrock', connection, retired, ceilingMicroUsd }),
    };
  };

  const prepareAzure = async (services: ModelApiServices, model: string, level: Effort): Promise<Prepared> => {
    if (!services.azure) throw new ApiError(503, 'The Azure OpenAI route is not available in this process.');
    const connection: AzureConnection | null = await services.azure.connections.read();
    let deployment: string | null = null;
    if (connection) {
      try {
        deployment = azureDeploymentFor(connection, model).deployment;
      } catch (error) {
        if (error instanceof ModelApiError)
          throw new QualificationRefused('qualify_unknown_model', `This Azure connection has no deployment for ${model}.`);
        throw error;
      }
    }
    const target = connection ? azureQualificationTarget(connection, model, level) : null;
    const ceilingMicroUsd = target ? plannedCeilingMicroUsd(target) : null;
    return {
      route: AZURE_OPENAI_ROUTE,
      model,
      deployment,
      required: false,
      ready:
        connection && target && ceilingMicroUsd !== null
          ? {
              connectionId: connection.id,
              fingerprint: connection.credential.fingerprint,
              identity: azureQualificationIdentity(connection, model),
              target,
              ceilingMicroUsd,
            }
          : null,
      blocked: admission(services, {
        route: AZURE_OPENAI_ROUTE,
        label: 'Azure',
        long: 'Azure OpenAI',
        connection,
        ceilingMicroUsd,
      }),
    };
  };

  /** The newest receipt for the prepared connection and model, and what it means now. */
  const viewOf = async (services: ModelApiServices, prepared: Prepared): Promise<RouteQualificationView> => {
    const receipt: RouteQualificationReceipt | null = prepared.ready
      ? await receiptsOf(services).latest(prepared.route, prepared.ready.connectionId, {
          ...(prepared.model ? { model: prepared.model } : {}),
          deployment: prepared.deployment,
        })
      : null;
    const verdict = receiptQualifies(receipt, prepared.ready?.identity ?? noIdentity(prepared.route), Date.now());
    return {
      route: prepared.route,
      model: prepared.model,
      deployment: prepared.deployment,
      receipt,
      qualifies: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      required: prepared.required,
      blocked: prepared.blocked?.message ?? null,
      ceilingMicroUsd: prepared.ready?.ceilingMicroUsd ?? null,
      running: prepared.ready ? running.has(runKey(prepared.route, prepared.ready.connectionId)) : false,
    };
  };

  /** One run: refuse with nothing sent, or run every check, record the receipt and return the fresh view. */
  const run = async (
    services: ModelApiServices,
    prepared: Prepared,
    level: Effort,
    res: Response,
    again: () => Promise<Prepared>,
  ): Promise<RouteQualificationView> => {
    const receipts = receiptsOf(services);
    if (prepared.blocked || !prepared.ready)
      throw new QualificationRefused(
        prepared.blocked?.code ?? 'qualify_no_connection',
        `${prepared.blocked?.message ?? 'Connect the route before running route checks.'} Nothing was sent.`,
      );
    const { target, fingerprint } = prepared.ready;
    const key = runKey(target.route, target.connectionId);
    // Checked again with no await before the add: two requests cannot both start.
    if (running.has(key))
      throw new QualificationRefused('qualify_running', 'Route checks are already running on this connection. Nothing was sent.');
    running.add(key);
    try {
      let secret: string;
      try {
        secret = await services.secrets.get(target.connectionId);
      } catch (error) {
        if (error instanceof HarnessError) throw new QualificationRefused(error.code, `${error.message} Nothing was sent.`);
        throw error;
      }
      if (secretFingerprint(secret) !== fingerprint)
        throw new QualificationRefused(
          'qualify_key_mismatch',
          'The saved key does not match this connection. Enter the key again before running route checks. Nothing was sent.',
        );
      const receipt = await runRouteQualification({
        target,
        secret,
        exposure: services.exposure,
        effort: level,
        signal: closedSignal(res),
        ...(services.transport ? { transport: services.transport } : {}),
      });
      try {
        await receipts.record(receipt);
      } catch {
        throw new ApiError(
          500,
          'The route checks ran, but their receipt could not be saved. What they spent is on the spend limit as usual.',
        );
      }
    } finally {
      running.delete(key);
    }
    return viewOf(services, await again());
  };

  const AWS = `/api/ai/model-api/${AWS_BEDROCK_ROUTE}`;
  const AZURE = `/api/ai/model-api/${AZURE_OPENAI_ROUTE}`;

  app.get(
    `${AWS}/qualification`,
    route(async () => {
      const services = api();
      return viewOf(services, await prepareAws(services, 'low'));
    }),
  );
  app.post(
    `${AWS}/qualify`,
    route(async (req) => {
      const body = awsBody.parse(req.body);
      const level = body.effort ?? 'low';
      const services = api();
      return run(services, await prepareAws(services, level), level, req.res!, () => prepareAws(services, level));
    }),
  );
  app.get(
    `${AZURE}/qualification`,
    route(async (req) => {
      const model = azureModel.parse(typeof req.query.model === 'string' ? req.query.model : '');
      const services = api();
      return viewOf(services, await prepareAzure(services, model, 'low'));
    }),
  );
  app.post(
    `${AZURE}/qualify`,
    route(async (req) => {
      const body = azureBody.parse(req.body);
      const level = body.effort ?? 'low';
      const services = api();
      return run(services, await prepareAzure(services, body.model, level), level, req.res!, () =>
        prepareAzure(services, body.model, level),
      );
    }),
  );
}

/** An identity no receipt matches: what a route with no connection is judged against. */
const noIdentity = (route: QualifiableRoute): QualificationIdentity => ({
  route,
  connectionId: '',
  connectionRevision: 0,
  model: '',
  protocol: 'openai-responses',
  rateCard: '',
  deployment: null,
});

/** Aborts when the client leaves before the answer is written: a Stop in the app closes the request. */
function closedSignal(res: Response): AbortSignal {
  const controller = new AbortController();
  if (res.closed && !res.writableEnded) controller.abort();
  else
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
  return controller.signal;
}
