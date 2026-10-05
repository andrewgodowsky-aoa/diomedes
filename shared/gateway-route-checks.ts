/**
 * Gateway route checks: Operations runs the route checks on one saved managed route through the
 * gateway's own provider call (`callManagedProvider`, the path customer calls take) with the
 * Worker's company credential for that route's approved connection, and gets back the receipt and
 * the evidence sentence to record on the route.
 *
 * The receipt is the same `RouteQualificationReceipt` the desktop's own-key checks write, with the
 * gateway connection as its identity: `route` is the connection's provider, `connectionId` and
 * `connectionRevision` are the approved connection's (`aws-bedrock-us-east-1`, revision 1), the
 * Azure deployment fills `deployment`, and `rateCard` is the route's own price version.
 *
 * Nothing here writes the route. The person reads the receipt and saves the route's evidence
 * themselves, choosing its tiers and quality floor; the receipt never decides those.
 */
import { z } from 'zod';
import type { RouteQualificationReceipt } from './route-qualification.js';

/** Staff only (`routes.write`). POST with a `routeChecksInputSchema` body. */
export const routeChecksPath = (routeId: string) => `/ops/routes/${encodeURIComponent(routeId)}/checks`;

export const routeChecksInputSchema = z.strictObject({
  /** The saved route revision the person is looking at. Any other saved revision refuses with 409. */
  baseRevision: z.number().int().min(1),
});
export type RouteChecksInput = z.infer<typeof routeChecksInputSchema>;

/** The `ops_audit` action of one run. Its `detail` holds the receipt and the run's spend. */
export const ROUTE_CHECKS_AUDIT_ACTION = 'route.checked' as const;

export interface RouteChecksResult {
  routeId: string;
  routeRevision: number;
  receipt: RouteQualificationReceipt;
  /** The `ops_audit` row holding this receipt. */
  auditId: string;
  /** For the route's evidence fields, naming the receipt and its audit row with the date. */
  evidence: string;
  /** `receiptQualifies` for the route's exact identity, at the time of the run. */
  qualifies: { ok: true } | { ok: false; reason: string };
  /** The worst case this run was allowed to spend, priced from the route's own price record. */
  boundMicroUsd: number;
  /** Priced from the usage the provider reported. */
  spentMicroUsd: number;
  /** Calls that were sent but reported no usage, held at their bound. */
  uncertainMicroUsd: number;
}

/** Refusal codes, carried as `{ error, code }` with the HTTP status beside each. */
export const ROUTE_CHECKS_REFUSALS = {
  /** 403: the staff key lacks `routes.write`. */
  forbidden: 403,
  /** 404: no saved route has this id. */
  unknown_route: 404,
  /** 409: the saved revision is not `baseRevision`. */
  route_changed: 409,
  /** 422: the route is retired, has no binding, or its connection is not approved. */
  route_not_checkable: 422,
  /** 422: the checks cover Bedrock and Azure OpenAI routes on the Responses and Chat Completions protocols only. */
  protocol_unsupported: 422,
  /** 422: the route's price record has no input or output price, so the run cannot be bounded. */
  price_missing: 422,
  /** 503: the connection's Worker secret is unset or unusable. */
  credential_unavailable: 503,
  /** 409: company spend, earlier route checks and this run's bound would pass the spend ceiling. */
  company_ceiling: 409,
} as const;
export type RouteChecksRefusal = keyof typeof ROUTE_CHECKS_REFUSALS;
