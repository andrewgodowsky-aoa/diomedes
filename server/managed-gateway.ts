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
import type { StaffRole } from '../shared/access.js';
import { MEMBER_LIMIT_REACHED } from '../shared/credit-allotments.js';
import { NO_ENTITLEMENT_REASON, type EntitlementView } from '../shared/workspaces.js';
import { ApiError } from './paths.js';
import type { PurchasedBalanceAnswer, PurchasedHoldAnswer } from './accounts/client.js';
import type { AllowanceLedger } from './managed-usage.js';

/** How long an admission's authorization is good for. */
export const AUTHORIZATION_MINUTES = 10;

export interface AdmissionRequest {
  readonly organizationId: string;
  readonly personId: string;
  readonly route: string;
  readonly kind: ChargeKind;
  /** The job this call belongs to. Null makes the call a job of its own. */
  readonly parentTaskId: string | null;
  readonly maxMicroUsd: MicroUsd;
  /** Binds the authorization to this request and no other. */
  readonly requestDigest: string;
  readonly reservationId: string;
  readonly periodId: string;
  readonly at: string;
  /**
   * Set by the host, and only by the host, when a person is asking to reserve
   * allowance themselves (the HTTP route). Never read from a request body.
   * Left unset, this is the app admitting its own managed work for a person.
   * A direct reservation of the company's allowance is refused where a hold
   * would be taken (owner rule, 2026-09-30) unless the asker is active Diomedes
   * staff. Usage bought outright is the other allowed kind (owner rule, 2026-10-01):
   * this app's local ledger keeps no line for it, so a non-staff direct reservation
   * is held by the account service against recorded top-ups instead (`purchased`),
   * and refused when the service holds nothing.
   */
  readonly directReservation?: boolean;
  /**
   * The asker's role when the account service has just said they are active staff. Set by
   * the host from that answer, and only by the host; never read from a request body. It
   * matters only to a direct reservation: left unset or null, that is refused.
   */
  readonly staffRole?: StaffRole | null;
}

export const DIRECT_RESERVATION_REFUSED = 'direct_reservation_refused';
export const DIRECT_RESERVATION_REASON =
  'You can’t reserve this business’s included usage yourself. Your work in the app draws on it as it runs. Nothing was held.';

/**
 * The account service's word on usage a business bought outright, for the person signed in here.
 * It is the only place that keeps that balance. This app asks; it never decides, and never keeps a
 * figure of its own for it.
 */
export interface PurchasedUsage {
  /** Who is signed in to the account service, to check against who is asking here. */
  personId(): string | null;
  /** What the business bought outright, and what of it is held or spent. */
  purchasedBalance(organizationId: string): Promise<PurchasedBalanceAnswer>;
  holdPurchased(
    organizationId: string,
    input: { holdId: string; amountMicroUsd: number; requestDigest: string },
  ): Promise<PurchasedHoldAnswer>;
  settlePurchased(
    organizationId: string,
    input: { holdId: string; debitMicroUsd: number },
  ): Promise<PurchasedHoldAnswer>;
  /** Move the hold's lease forward. Only the person who made the hold can; the service says when it lapses. */
  renewPurchased(organizationId: string, input: { holdId: string }): Promise<PurchasedHoldAnswer>;
}

/** What a person's request for bought usage can be refused with, and the status each answers with. */
export const PURCHASED_REFUSAL_STATUS: Readonly<Record<string, number>> = Object.freeze({
  no_purchased_usage: 403,
  insufficient_purchased_usage: 409,
  // The member's own monthly limit, which bought usage counts toward like any other.
  [MEMBER_LIMIT_REACHED]: 409,
  hold_conflict: 409,
  hold_closed: 409,
  purchased_hold_invalid: 400,
  purchased_hold_unavailable: 503,
  purchased_sign_in_required: 401,
});
const PURCHASED_UNAVAILABLE_REASON = 'Bought usage can’t be held right now.';
const PURCHASED_UNREACHABLE_REASON =
  'The account service couldn’t be reached, so bought usage can’t be held.';
const PURCHASED_INVALID_REASON = 'That reservation can’t be held as asked.';
const PURCHASED_SIGN_IN_REASON = 'Sign in to Nectovia to hold usage this business bought.';
const PURCHASED_OTHER_PERSON_REASON =
  'This app is signed in to a different account than the one asking, so bought usage can’t be held.';

/** Settling is a person's word about what a hold cost, so it is closed to people the same way. */
export const DIRECT_SETTLE_REFUSED = 'direct_settle_refused';
export const DIRECT_SETTLE_REASON =
  'You can’t settle this business’s usage yourself. Your work in the app settles as it finishes. Nothing was changed.';

/**
 * Renewing a hold keeps usage the business bought outright from lapsing while its work runs. A hold
 * this person did not make reads the same as one that does not exist, as it does for a settle. Staff
 * hold on this computer's own ledger, which keeps no lease, so there is nothing of theirs to renew.
 */
export const DIRECT_RENEW_REFUSED = 'direct_renew_refused';
export const DIRECT_RENEW_REASON =
  'You can’t renew a hold you didn’t make.';
export const STAFF_RENEW_REFUSED = 'staff_hold_not_leased';
export const STAFF_RENEW_REASON =
  'Staff holds are kept on this computer and don’t run out, so there is nothing to renew.';

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
  /**
   * The billing record's own answer on security suspension. Consulted only on
   * the managed path — a suspended company account never blocks a person's
   * own key or a local route, and a paid invoice never lifts a suspension.
   */
  readonly billingStatusFor: (organizationId: string) => Promise<{
    suspended: boolean;
    suspendedReason: string | null;
  }>;
  /**
   * The job's cap, from the host's tier map (`APPROVED_JOB_CAP_CREDITS`) and
   * any one-job raise the host recorded. Never a request field: a caller that
   * could name its own envelope could name any envelope.
   */
  readonly jobCapFor: (organizationId: string, jobId: string) => MicroUsd;
  /**
   * The account service's holds on usage a business bought outright. Left out or null, a person
   * who is not staff cannot reserve anything: this install cannot show them any purchased usage.
   */
  readonly purchased?: PurchasedUsage | null;
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

    // Entitlement and the absence of a security suspension answer together on
    // the managed path. Suspension is checked first: it is a property of the
    // billing record itself, so no invoice, plan or request field outranks it.
    // An unreadable request clock refuses before any of this: no reservation
    // may be minted against a time that cannot be proven, and the
    // authorization's expiry is derived from it.
    if (!Number.isFinite(Date.parse(request.at)))
      return refuse(
        'invalid_clock',
        'The request time is not readable; nothing was reserved and nothing was admitted.',
        'managed',
      );

    const billing = await this.deps.billingStatusFor(organizationId);
    if (billing.suspended)
      return refuse(
        'security_suspended',
        billing.suspendedReason ||
          'This business is under a security suspension. Paying an invoice does not lift it.',
        'managed',
      );

    if (!entitlement.managedInference)
      return refuse('no_entitlement', entitlement.reason || NO_ENTITLEMENT_REASON, 'managed');

    // A charge whose ceiling cannot be known before the call cannot be held
    // against a hard cap, so it is not run on the allowance at all.
    if (!isAdmissibleChargeKind(RATE_CARD_V1, request.kind))
      return refuse('charge_not_admissible', RATE_CARD_V1.reason[request.kind], 'managed');

    // Money last. Everything above had to pass on its own terms first. The job's cap is the
    // host's; every child and every retry under one parent task is held inside it, and a call
    // with no parent task is a job of its own, held to the same cap alone.
    const jobCap = this.deps.jobCapFor(organizationId, request.parentTaskId ?? request.reservationId);
    if (request.parentTaskId === null && request.maxMicroUsd > jobCap)
      return refuse(
        'job_cap_reached',
        'This call could cost more than one job is capped at. Nothing was held and nothing was sent.',
        'managed',
      );
    // A person asking to hold the company's allowance themselves stops here,
    // at the last gate before money, unless the host has shown them to be
    // active staff. Local and own-key work held nothing and returned above, and
    // an unpaid, suspended or over-cap request has already been refused for its
    // own reason, so only a hold that would draw on included usage reaches this
    // line.
    if (request.directReservation && !request.staffRole) {
      if (!this.deps.purchased) return refuse(DIRECT_RESERVATION_REFUSED, DIRECT_RESERVATION_REASON, 'managed');
      return this.holdPurchased(this.deps.purchased, request, tenantId);
    }
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
        parentEnvelopeMicroUsd: request.parentTaskId === null ? null : jobCap,
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

  /**
   * A person who is not staff reserving: held by the account service against the credits this
   * business bought outright, or refused. Only the last gate before money reaches here, so every
   * earlier question has already been answered. Nothing is written to the local ledger, which keeps
   * no purchased line and would otherwise hold the included month. An answer this build cannot
   * read, a service that cannot be reached, and anything unexpected all refuse with nothing held.
   */
  private async holdPurchased(
    purchased: PurchasedUsage,
    request: AdmissionRequest,
    tenantId: string,
  ): Promise<Admission> {
    if (purchased.personId() !== request.personId)
      return refuse('purchased_hold_unavailable', PURCHASED_OTHER_PERSON_REASON, 'managed');
    let answer: PurchasedHoldAnswer;
    try {
      answer = await purchased.holdPurchased(request.organizationId, {
        holdId: request.reservationId,
        amountMicroUsd: request.maxMicroUsd,
        requestDigest: request.requestDigest,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        const code = String((error.details as { code?: unknown }).code ?? '');
        // The service's own refusals say what is wrong in plain words, and are passed on as they are.
        if (code in PURCHASED_REFUSAL_STATUS && !code.startsWith('purchased_'))
          return refuse(code, error.message, 'managed');
        // The service could not read what was asked: an identifier or amount it does not accept.
        if (error.status === 422) return refuse('purchased_hold_invalid', PURCHASED_INVALID_REASON, 'managed');
        if (error.status === 401)
          return refuse('purchased_sign_in_required', PURCHASED_SIGN_IN_REASON, 'managed');
        if (error.status === 503 || code === 'unreachable')
          return refuse('purchased_hold_unavailable', PURCHASED_UNREACHABLE_REASON, 'managed');
      }
      return refuse('purchased_hold_unavailable', PURCHASED_UNAVAILABLE_REASON, 'managed');
    }
    // Held is the only state that took credits aside for this call. Anything else holds nothing.
    // The hold is a lease: the authorization never outlasts it, and one this app cannot read is not a hold.
    const lease = Date.parse(answer.leaseUntil);
    if (
      answer.state !== 'held' ||
      answer.holdId !== request.reservationId ||
      answer.amountMicroUsd !== request.maxMicroUsd ||
      !Number.isFinite(lease)
    )
      return refuse('purchased_hold_unavailable', PURCHASED_UNAVAILABLE_REASON, 'managed');
    const reservation: Reservation = {
      id: request.reservationId,
      organizationId: request.organizationId,
      periodId: request.periodId,
      parentTaskId: request.parentTaskId,
      kind: request.kind,
      route: request.route,
      payer: 'managed',
      maxMicroUsd: request.maxMicroUsd,
      rateCardVersion: RATE_CARD_V1.version,
      state: 'pending',
      createdAt: request.at,
      resolvedAt: null,
      uncertainReason: null,
    };
    return {
      admitted: true,
      payer: 'managed',
      reservation,
      authorization: {
        tenantId,
        audience: request.route,
        requestDigest: request.requestDigest,
        // The earlier of the usual window and the hold's own lease: this never says a call may go
        // ahead past the moment the credits behind it let go.
        expiresAt: new Date(
          Math.min(Date.parse(request.at) + AUTHORIZATION_MINUTES * 60_000, lease),
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
  const at = Date.parse(against.at);
  if (!Number.isFinite(at))
    return { valid: false, reason: 'The observation time is not readable.' };
  const expires = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(expires))
    return { valid: false, reason: 'This authorization carries an unreadable expiry.' };
  if (at >= expires) return { valid: false, reason: 'This authorization has expired.' };
  return { valid: true, reason: '' };
}
