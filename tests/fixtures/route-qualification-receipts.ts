/**
 * Route check receipts for tests: a passing receipt for one exact identity, which a test then
 * varies one field at a time. Synthetic: no provider was called to make any of these.
 */
import {
  QUALIFICATION_CHECKS,
  QUALIFICATION_VALID_DAYS,
  ROUTE_QUALIFICATION_VERSION,
  routeQualificationReceiptSchema,
  type QualificationIdentity,
  type RouteQualificationReceipt,
} from '../../shared/route-qualification.js';

const DAY_MS = 86_400_000;

export interface ReceiptIdentity extends QualificationIdentity {
  endpoint: string;
  sdk: string;
}

/** A receipt every check passed, made at `createdAt` (now by default) for exactly this identity. */
export function passingReceipt(
  identity: ReceiptIdentity,
  options: { createdAt?: Date; id?: string; patch?: Partial<RouteQualificationReceipt> } = {},
): RouteQualificationReceipt {
  const createdAt = options.createdAt ?? new Date();
  const usage = { inputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 8, reasoningTokens: 4 };
  return routeQualificationReceiptSchema.parse({
    v: ROUTE_QUALIFICATION_VERSION,
    id: options.id ?? 'rq_fixture0001',
    createdAt: createdAt.toISOString(),
    validUntil: new Date(createdAt.getTime() + QUALIFICATION_VALID_DAYS * DAY_MS).toISOString(),
    route: identity.route,
    connectionId: identity.connectionId,
    connectionRevision: identity.connectionRevision,
    endpoint: identity.endpoint,
    deployment: identity.deployment,
    model: identity.model,
    servedModels: [identity.model],
    protocol: identity.protocol,
    sdk: identity.sdk,
    effort: 'low',
    rateCard: identity.rateCard,
    checks: QUALIFICATION_CHECKS.map((id) => ({
      id,
      outcome: 'passed',
      detail: 'Synthetic fixture: no provider was called.',
      calls: [
        {
          status: 200,
          providerRequestId: 'req-fixture',
          responseId: 'resp-fixture',
          reportedModel: identity.model,
          finish: id === 'tool-round-trip' ? 'tool-call' : 'completed',
          incompleteReason: null,
          maxOutputTokens: id === 'output-bound' ? 64 : 512,
          usage,
          error: null,
          ledger: { state: 'settled', microUsd: 100 },
          elapsedMs: 10,
        },
      ],
    })),
    verdicts: { answers: true, outputBound: 'bounded', tools: 'one-call', cacheDefault: 'no-cache-observed', cacheOff: 'verified' },
    spend: { settledMicroUsd: 500, uncertainMicroUsd: 0 },
    ...options.patch,
  });
}
