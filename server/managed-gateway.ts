/**
 * What has to be true before a company's provider key is used.
 *
 * The company's keys live on this server and are never handed to a client.
 * That is the whole reason this file exists rather than a proxy route: a proxy
 * authenticates a caller and forwards a request, and this decides whether the
 * request should exist at all — under whose terms, against whose money, with
 * what leaving the computer.
 *
 * The checks run in a fixed order, cheapest and most conclusive first, and the
 * order is load-bearing rather than tidy. Each one answers a question the next
 * one assumes. A budget reservation, in particular, is the last thing that
 * happens and never stands in for permission: money held is not authority to
 * execute, and a revoked membership with a live hold is still a refusal.
 *
 *   identity → membership → entitlement → data route → charge kind → payer → budget
 *
 * Nothing a caller sends is authority. A body may say `paid: true`, may carry
 * an entitlement object, may name a different organization; the gateway reads
 * membership, entitlement, tenant and policy from the host's own resolvers,
 * which is why they are constructor dependencies rather than request fields.
 *
 * The authorization it returns is deliberately narrow: one tenant, one
 * upstream, one request, a few minutes. It exists so the thing that actually
 * dispatches can prove it is running the call that was admitted, and not a
 * second call that borrowed the first one's approval.
 */
import {
  LOCAL_ROUTES,
  RATE_CARD_V1,
  isAdmissibleChargeKind,
  payerForRoute,
  type ChargeKind,
  type MicroUsd,
  type OrganizationRoute,
  type Payer,
  type Reservation,
} from '../shared/managed-usage.js';
import { NO_ENTITLEMENT_REASON, type EntitlementView } from '../shared/workspaces.js';
import { ApiError } from './paths.js';
import type { AllowanceLedger } from './managed-usage.js';

/** How long an admission's authorization is good for. */
export const AUTHORIZATION_MINUTES = 10;

export interface AdmissionRequest {
  readonly organizationId: string;
  readonly personId: string;
  readonly route: string;
  readonly kind: ChargeKind;
  readonly parentTaskId: string | null;
  readonly maxMicroUsd: MicroUsd;
  readonly parentEnvelopeMicroUsd: MicroUsd | null;
  /** Binds the authorization to this request and no other. */
  readonly requestDigest: string;
  readonly reservationId: string;
  readonly periodId: string;
  readonly at: string;
}

export interface GatewayAuthorization {
  readonly tenantId: string;
  /** The upstream this is good for, and only that. */
  readonly audience: string;
  readonly requestDigest: string;
  readonly expiresAt: string;
  readonly reservationId: string;
}

export type Admission =
  | {
      readonly admitted: true;
      readonly payer: Payer;
      /** Null for a payer that costs the company nothing upstream. */
      readonly reservation: Reservation | null;
      readonly authorization: GatewayAuthorization | null;
    }
  | {
      readonly admitted: false;
      readonly code: string;
      readonly message: string;
      readonly payer: Payer;
    };

export interface OrganizationPolicy {
  readonly processing: 'local-only' | 'non-sensitive-may-leave' | 'may-leave';
  readonly organizationRoute: OrganizationRoute;
}

export interface GatewayDependencies {
  readonly ledger: AllowanceLedger;
  /** The host's entitlement answer. Not a request field, ever. */
  readonly entitlementFor: (organizationId: string) => EntitlementView;
  readonly tenantFor: (organizationId: string) => string | null;
  readonly memberOf: (organizationId: string, personId: string) => boolean;
  readonly policyFor: (organizationId: string) => OrganizationPolicy;
}

const refuse = (code: string, message: string, payer: Payer = 'refused'): Admission => ({
  admitted: false,
  code,
  message,
  payer,
});

/** A route that never leaves this computer cannot breach a data-route policy. */
const isLocal = (route: string) => LOCAL_ROUTES.includes(route);

export class ManagedGateway {
  constructor(private readonly deps: GatewayDependencies) {}

  async admit(request: AdmissionRequest): Promise<Admission> {
    const { organizationId, personId } = request;

    // Identity and membership. A revoked or merely invited membership is not
    // active, and an inactive one reads exactly like no membership at all.
    if (!this.deps.memberOf(organizationId, personId))
      return refuse(
        'not_a_member',
        'You are not an active member of this business, so nothing runs on its account.',
      );
    const tenantId = this.deps.tenantFor(organizationId);
    if (!tenantId)
      return refuse('no_tenant', 'This business has no tenant to label its work under.');

    // Entitlement. In a build with no entitlement service this refuses every
    // managed admission, which is the honest answer: installing that service is
    // the only thing that changes it, and no local record or request field can.
    const entitlement = this.deps.entitlementFor(organizationId);
    const policy = this.deps.policyFor(organizationId);
    const payer = payerForRoute({
      route: request.route,
      organizationRoute: policy.organizationRoute,
    });

    // The data-route check runs before entitlement matters, for local work
    // only: a local-only business asking for a remote route is refused whether
    // or not it has a plan, and a local route is not the gateway's business to
    // price. Order matters here — checking entitlement first would refuse a
    // purely local call for want of a plan it does not need.
    if (policy.processing === 'local-only' && !isLocal(request.route))
      return refuse(
        'data_route_refused',
        'This business keeps its work on its own computers, and that route sends work elsewhere. Nothing was sent and nothing was downgraded quietly.',
        payer.payer,
      );

    if (payer.payer === 'local')
      return { admitted: true, payer: 'local', reservation: null, authorization: null };

    if (payer.payer === 'refused')
      return refuse('payer_refused', payer.reason ?? 'No payer could be resolved for this work.');

    if (payer.payer === 'byo')
      // The company's own key, the company's own bill. Nothing is held here
      // because nothing of the company's allowance is at stake.
      return { admitted: true, payer: 'byo', reservation: null, authorization: null };

    if (!entitlement.managedInference)
      return refuse('no_entitlement', entitlement.reason || NO_ENTITLEMENT_REASON, 'managed');

    // A charge whose ceiling cannot be known before the call cannot be held
    // against a hard cap, so it is not run on the allowance at all.
    if (!isAdmissibleChargeKind(RATE_CARD_V1, request.kind))
      return refuse('charge_not_admissible', RATE_CARD_V1.reason[request.kind], 'managed');

    // Money last. Everything above had to pass on its own terms first.
    let reservation: Reservation;
    try {
      reservation = await this.deps.ledger.reserve({
        reservationId: request.reservationId,
        organizationId,
        periodId: request.periodId,
        parentTaskId: request.parentTaskId,
        kind: request.kind,
        route: request.route,
        payer: 'managed',
        maxMicroUsd: request.maxMicroUsd,
        rateCardVersion: RATE_CARD_V1.version,
        parentEnvelopeMicroUsd: request.parentEnvelopeMicroUsd,
        at: request.at,
      });
    } catch (error) {
      // The ledger's refusal is the better one: it knows which bound stopped
      // this and what would fix it. Repeating it in different words here would
      // give two answers to one question.
      if (error instanceof ApiError)
        return refuse(
          String((error.details as { code?: string }).code ?? 'budget_refused'),
          error.message,
          'managed',
        );
      throw error;
    }

    return {
      admitted: true,
      payer: 'managed',
      reservation,
      authorization: {
        tenantId,
        audience: request.route,
        requestDigest: request.requestDigest,
        expiresAt: new Date(
          Date.parse(request.at) + AUTHORIZATION_MINUTES * 60_000,
        ).toISOString(),
        reservationId: reservation.id,
      },
    };
  }
}

/**
 * Whether an authorization is good for the call about to be made.
 *
 * Each mismatch is named separately because they mean different things. A
 * different request digest is a replay or a substitution; a different tenant is
 * a cross-company attempt; an expired one is usually just slow.
 */
export function verifyAuthorization(
  authorization: GatewayAuthorization,
  against: { tenantId: string; audience: string; requestDigest: string; at: string },
): { valid: boolean; reason: string } {
  if (authorization.tenantId !== against.tenantId)
    return { valid: false, reason: 'This authorization belongs to a different tenant.' };
  if (authorization.audience !== against.audience)
    return { valid: false, reason: 'This authorization is for a different upstream service.' };
  if (authorization.requestDigest !== against.requestDigest)
    return { valid: false, reason: 'This authorization was issued for a different request.' };
  if (Date.parse(against.at) >= Date.parse(authorization.expiresAt))
    return { valid: false, reason: 'This authorization has expired.' };
  return { valid: true, reason: '' };
}
